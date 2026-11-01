<?php
declare(strict_types=1);

/**
 * PDF → MusicXML conversion endpoint for KlavierXML.com (Audiveris on Mac2017).
 *
 * POST multipart/form-data:
 *   pdf: file (required)
 *   title: string (optional)
 *   composer: string (optional)
 *
 * Returns application/vnd.recordare.musicxml+xml (raw MusicXML) on success,
 * or application/json error.
 */

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
  http_response_code(405);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'POST a PDF file as field "pdf".']);
  exit;
}

@set_time_limit(0);
@ini_set('max_execution_time', '0');
@ini_set('memory_limit', '512M');

const MAX_PDF_BYTES = 40 * 1024 * 1024; // 40 MB
const AUDIVERIS_HOME = '/usr/local/klavierxml-audiveris/audiveris';
const WORK_ROOT = '/Library/WebServer/KlavierXML-data/pdf2xml-work';
const PDF2XML_BIN = '/usr/local/klavierxml-audiveris/audiveris/bin/pdf2xml.sh';
const ENHANCE_PY = '/usr/local/klavierxml-audiveris/enhance_score_pdf.py';
const PYTHON = '/usr/bin/python3';

try {
  if (!isset($_FILES['pdf']) || !is_array($_FILES['pdf'])) {
    throw new RuntimeException('Missing PDF upload (field name: pdf).');
  }
  $file = $_FILES['pdf'];
  if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    throw new RuntimeException('Upload failed (PHP error ' . (int) $file['error'] . ').');
  }
  if (($file['size'] ?? 0) <= 0 || $file['size'] > MAX_PDF_BYTES) {
    throw new RuntimeException('PDF must be between 1 byte and 40 MB.');
  }

  $tmpName = (string) $file['tmp_name'];
  $finfo = new finfo(FILEINFO_MIME_TYPE);
  $mime = $finfo->file($tmpName) ?: '';
  $origName = (string) ($file['name'] ?? 'score.pdf');
  $ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
  if ($ext !== 'pdf' && $mime !== 'application/pdf' && $mime !== 'application/x-pdf') {
    throw new RuntimeException('Only PDF files are accepted.');
  }

  $title = trim((string) ($_POST['title'] ?? ''));
  $composer = trim((string) ($_POST['composer'] ?? ''));

  if (!is_dir(WORK_ROOT) && !@mkdir(WORK_ROOT, 0775, true) && !is_dir(WORK_ROOT)) {
    throw new RuntimeException('Cannot create work directory.');
  }

  $jobId = 'job-' . date('Ymd-His') . '-' . bin2hex(random_bytes(4));
  $jobDir = WORK_ROOT . '/' . $jobId;
  if (!mkdir($jobDir, 0775, true) && !is_dir($jobDir)) {
    throw new RuntimeException('Cannot create job directory.');
  }

  $safeBase = preg_replace('/[^A-Za-z0-9._-]+/', '_', pathinfo($origName, PATHINFO_FILENAME)) ?: 'score';
  $inputPdf = $jobDir . '/' . $safeBase . '.pdf';
  if (!move_uploaded_file($tmpName, $inputPdf)) {
    throw new RuntimeException('Could not store uploaded PDF.');
  }

  $pdfForOmr = $inputPdf;
  $enhanced = $jobDir . '/enhanced.pdf';
  if (is_file(ENHANCE_PY) && is_executable(PYTHON)) {
    $pyDeps = '/usr/local/klavierxml-audiveris/pydeps';
    $envPrefix = 'PYTHONPATH=' . escapeshellarg($pyDeps) . ' ';
    $cmd = $envPrefix . escapeshellarg(PYTHON) . ' ' . escapeshellarg(ENHANCE_PY) . ' '
      . escapeshellarg($inputPdf) . ' ' . escapeshellarg($enhanced) . ' 2>&1';
    exec($cmd, $enhOut, $enhCode);
    if ($enhCode === 0 && is_file($enhanced) && filesize($enhanced) > 0) {
      $pdfForOmr = $enhanced;
    }
  }

  $outDir = $jobDir . '/out';
  mkdir($outDir, 0775, true);
  if (!is_file(PDF2XML_BIN)) {
    throw new RuntimeException('Audiveris converter is not installed on the server.');
  }

  $logFile = $jobDir . '/audiveris.log';
  $cmd = escapeshellarg(PDF2XML_BIN) . ' '
    . escapeshellarg($pdfForOmr) . ' '
    . escapeshellarg($outDir)
    . ' > ' . escapeshellarg($logFile) . ' 2>&1';
  exec($cmd, $omrOut, $omrCode);

  $xmlPath = find_best_musicxml($outDir, $safeBase);
  if ($xmlPath === null) {
    // Retry export from .omr if present (invalid cover pages)
    $omr = find_first($outDir, 'omr');
    if ($omr !== null) {
      $retryLog = $jobDir . '/audiveris-retry.log';
      $cmd = escapeshellarg(PDF2XML_BIN) . ' '
        . escapeshellarg($omr) . ' '
        . escapeshellarg($outDir)
        . ' > ' . escapeshellarg($retryLog) . ' 2>&1';
      exec($cmd, $retryOut, $retryCode);
      $xmlPath = find_best_musicxml($outDir, $safeBase);
    }
  }

  if ($xmlPath === null) {
    $tail = '';
    if (is_file($logFile)) {
      $tail = trim((string) shell_exec('tail -n 40 ' . escapeshellarg($logFile)));
    }
    throw new RuntimeException(
      'Conversion finished but no MusicXML was produced.'
      . ($tail !== '' ? "\n\nAudiveris log:\n" . $tail : '')
    );
  }

  $xml = (string) file_get_contents($xmlPath);
  if ($xml === '') {
    throw new RuntimeException('MusicXML file was empty.');
  }

  if ($title !== '' || $composer !== '') {
    $xml = patch_musicxml_metadata($xml, $title, $composer);
  }

  $downloadName = $safeBase . '.xml';
  header('Content-Type: application/vnd.recordare.musicxml+xml; charset=utf-8');
  header('Content-Disposition: attachment; filename="' . $downloadName . '"');
  header('X-KlavierXML-Job: ' . $jobId);
  echo $xml;
  exit;
} catch (Throwable $e) {
  http_response_code(500);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
  exit;
}

function find_first(string $dir, string $ext): ?string
{
  $it = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
  );
  foreach ($it as $file) {
    /** @var SplFileInfo $file */
    if (strtolower($file->getExtension()) === strtolower($ext)) {
      return $file->getPathname();
    }
  }
  return null;
}

function find_best_musicxml(string $dir, string $preferredRadix): ?string
{
  $preferred = [
    $dir . '/' . $preferredRadix . '.xml',
    $dir . '/enhanced.xml',
  ];
  foreach ($preferred as $path) {
    if (is_file($path) && filesize($path) > 200) {
      return $path;
    }
  }

  $candidates = [];
  $it = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
  );
  foreach ($it as $file) {
    /** @var SplFileInfo $file */
    $name = strtolower($file->getFilename());
    if ($file->getExtension() !== 'xml') {
      continue;
    }
    if ($name === 'book.xml' || str_ends_with($name, '.log.xml')) {
      continue;
    }
    $path = $file->getPathname();
    $text = (string) @file_get_contents($path);
    $measures = substr_count($text, '<measure');
    $candidates[] = ['path' => $path, 'measures' => $measures, 'bytes' => strlen($text)];
  }
  if ($candidates === []) {
    return null;
  }
  usort($candidates, static function ($a, $b) {
    if ($a['measures'] !== $b['measures']) {
      return $b['measures'] <=> $a['measures'];
    }
    return $b['bytes'] <=> $a['bytes'];
  });
  return $candidates[0]['path'];
}

function patch_musicxml_metadata(string $xml, string $title, string $composer): string
{
  if ($title !== '') {
    $escaped = htmlspecialchars($title, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    if (preg_match('/<movement-title>[^<]*<\/movement-title>/', $xml)) {
      $xml = preg_replace(
        '/<movement-title>[^<]*<\/movement-title>/',
        '<movement-title>' . $escaped . '</movement-title>',
        $xml,
        1
      ) ?? $xml;
    } elseif (preg_match('/<score-partwise[^>]*>/', $xml, $m, PREG_OFFSET_CAPTURE)) {
      $pos = $m[0][1] + strlen($m[0][0]);
      $xml = substr($xml, 0, $pos)
        . "\n  <movement-title>{$escaped}</movement-title>"
        . substr($xml, $pos);
    }
  }

  if ($composer !== '') {
    $escaped = htmlspecialchars($composer, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    if (preg_match('/<creator\s+type="composer">[^<]*<\/creator>/', $xml)) {
      $xml = preg_replace(
        '/<creator\s+type="composer">[^<]*<\/creator>/',
        '<creator type="composer">' . $escaped . '</creator>',
        $xml,
        1
      ) ?? $xml;
    } elseif (preg_match('/<identification>/', $xml, $m, PREG_OFFSET_CAPTURE)) {
      $pos = $m[0][1] + strlen($m[0][0]);
      $xml = substr($xml, 0, $pos)
        . "\n    <creator type=\"composer\">{$escaped}</creator>"
        . substr($xml, $pos);
    }
  }

  return $xml;
}

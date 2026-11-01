<?php
declare(strict_types=1);

/**
 * PDF → MusicXML conversion endpoint for KlavierXML.com (Audiveris on Mac2017).
 *
 * POST multipart/form-data:
 *   pdf: file (required)
 *   title / composer: optional
 * Returns JSON immediately: { jobId, status: "queued" }, then converts in-process
 * after fastcgi_finish_request() so the browser can poll without holding one long request.
 *
 * GET ?job=<id>           → JSON status
 * GET ?job=<id>&download=1 → MusicXML when done
 */

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const MAX_PDF_BYTES = 40 * 1024 * 1024; // 40 MB
const WORK_ROOT = '/Library/WebServer/KlavierXML-data/pdf2xml-work';
const AUDIVERIS_BIN = '/usr/local/klavierxml-audiveris/audiveris/bin/pdf2xml.sh';
const ENHANCE_PY = '/usr/local/klavierxml-audiveris/enhance_score_pdf.py';
const PYTHON = '/usr/bin/python3';
const PYDEPS = '/usr/local/klavierxml-audiveris/pydeps';

// Planning rate from live Noten batch (safe ETA; measured avg was ~0.9 s/measure).
const SEC_PER_MEASURE = 1.3;
// Measures ≈ PDF bytes × this factor (443 measures / 2,847,184 bytes in that batch).
const MEASURES_PER_PDF_BYTE = 443 / 2847184;

@ini_set('memory_limit', '512M');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
  if ($method === 'GET') {
    handle_get();
  } elseif ($method === 'POST') {
    handle_post();
  } else {
    http_response_code(405);
    json_out(['error' => 'Use POST to upload a PDF, or GET ?job=… to poll.']);
  }
} catch (Throwable $e) {
  http_response_code(500);
  json_out(['error' => $e->getMessage()]);
}

function handle_get(): void
{
  $jobId = trim((string) ($_GET['job'] ?? ''));
  if ($jobId === '' || !preg_match('/^job-[A-Za-z0-9_-]+$/', $jobId)) {
    throw new RuntimeException('Missing or invalid job id.');
  }

  $jobDir = WORK_ROOT . '/' . $jobId;
  $statusPath = $jobDir . '/status.json';
  if (!is_dir($jobDir) || !is_file($statusPath)) {
    http_response_code(404);
    json_out(['error' => 'Unknown job.', 'jobId' => $jobId]);
  }

  $status = read_status($statusPath);
  $wantDownload = isset($_GET['download']) && (string) $_GET['download'] !== '0';

  if ($wantDownload) {
    if (($status['status'] ?? '') !== 'done') {
      http_response_code(409);
      json_out([
        'error' => 'Conversion is not finished yet.',
        'jobId' => $jobId,
        'status' => $status['status'] ?? 'unknown',
      ]);
    }
    $xmlRel = (string) ($status['xml'] ?? '');
    $xmlPath = $jobDir . '/' . ltrim($xmlRel, '/');
    if ($xmlRel === '' || !is_file($xmlPath)) {
      throw new RuntimeException('MusicXML missing for completed job.');
    }
    $downloadName = (string) ($status['downloadName'] ?? basename($xmlPath));
    header('Content-Type: application/vnd.recordare.musicxml+xml; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $downloadName . '"');
    header('X-KlavierXML-Job: ' . $jobId);
    header('Content-Length: ' . (string) filesize($xmlPath));
    readfile($xmlPath);
    exit;
  }

  json_out(status_payload($jobId, $status));
}

function handle_post(): void
{
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
  $downloadName = build_download_name($title, $composer, $safeBase);
  $inputPdf = $jobDir . '/' . $safeBase . '.pdf';
  if (!move_uploaded_file($tmpName, $inputPdf)) {
    throw new RuntimeException('Could not store uploaded PDF.');
  }

  $estimate = estimate_conversion((int) $file['size']);
  $meta = [
    'jobId' => $jobId,
    'pdf' => basename($inputPdf),
    'safeBase' => $safeBase,
    'downloadName' => $downloadName,
    'title' => $title,
    'composer' => $composer,
    'origName' => $origName,
    'createdAt' => gmdate('c'),
    'pdfBytes' => (int) $file['size'],
    'estimatedMeasures' => $estimate['estimatedMeasures'],
    'estimatedSeconds' => $estimate['estimatedSeconds'],
    'secPerMeasure' => SEC_PER_MEASURE,
  ];
  file_put_contents($jobDir . '/meta.json', json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
  write_status($jobDir, [
    'status' => 'queued',
    'pct' => 2,
    'message' => 'Upload received. Starting Audiveris…',
    'error' => null,
    'downloadName' => $downloadName,
    'estimatedMeasures' => $estimate['estimatedMeasures'],
    'estimatedSeconds' => $estimate['estimatedSeconds'],
    'secPerMeasure' => SEC_PER_MEASURE,
  ]);

  // Return immediately so the browser can poll; conversion continues below.
  ignore_user_abort(true);
  @set_time_limit(0);
  @ini_set('max_execution_time', '0');

  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(status_payload($jobId, [
    'status' => 'queued',
    'pct' => 2,
    'message' => 'Upload received. Converting in the background…',
    'error' => null,
    'downloadName' => $downloadName,
    'estimatedMeasures' => $estimate['estimatedMeasures'],
    'estimatedSeconds' => $estimate['estimatedSeconds'],
    'secPerMeasure' => SEC_PER_MEASURE,
  ]), JSON_UNESCAPED_UNICODE);

  if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
  } else {
    if (function_exists('ob_get_level')) {
      while (ob_get_level() > 0) {
        ob_end_flush();
      }
    }
    flush();
  }

  run_conversion_job($jobDir, $meta);
  exit;
}

function run_conversion_job(string $jobDir, array $meta): void
{
  $safeBase = (string) ($meta['safeBase'] ?? 'score');
  $pdfName = (string) ($meta['pdf'] ?? ($safeBase . '.pdf'));
  $inputPdf = $jobDir . '/' . $pdfName;
  $title = trim((string) ($meta['title'] ?? ''));
  $composer = trim((string) ($meta['composer'] ?? ''));
  $downloadName = (string) ($meta['downloadName'] ?? build_download_name($title, $composer, $safeBase));

  try {
    if (!is_file($inputPdf)) {
      throw new RuntimeException('Uploaded PDF missing.');
    }

    write_status($jobDir, [
      'status' => 'running',
      'pct' => 8,
      'message' => 'Preparing score image…',
      'error' => null,
      'downloadName' => $downloadName,
    ]);

    $pdfForOmr = $inputPdf;
    $enhanced = $jobDir . '/enhanced.pdf';
    if (is_file(ENHANCE_PY) && is_executable(PYTHON)) {
      $cmd = 'PYTHONPATH=' . escapeshellarg(PYDEPS) . ' '
        . escapeshellarg(PYTHON) . ' ' . escapeshellarg(ENHANCE_PY) . ' '
        . escapeshellarg($inputPdf) . ' ' . escapeshellarg($enhanced);
      exec($cmd . ' 2>&1', $enhOut, $enhCode);
      if ($enhCode === 0 && is_file($enhanced) && filesize($enhanced) > 0) {
        $pdfForOmr = $enhanced;
      }
    }

    write_status($jobDir, [
      'status' => 'running',
      'pct' => 18,
      'message' => 'Running Audiveris (this can take several minutes)…',
      'error' => null,
      'downloadName' => $downloadName,
    ]);

    $outDir = $jobDir . '/out';
    if (!is_dir($outDir) && !mkdir($outDir, 0775, true) && !is_dir($outDir)) {
      throw new RuntimeException('Cannot create output directory.');
    }
    if (!is_file(AUDIVERIS_BIN)) {
      throw new RuntimeException('Audiveris converter is not installed.');
    }

    $logFile = $jobDir . '/audiveris.log';
    $cmd = escapeshellarg(AUDIVERIS_BIN) . ' '
      . escapeshellarg($pdfForOmr) . ' '
      . escapeshellarg($outDir)
      . ' > ' . escapeshellarg($logFile) . ' 2>&1';
    exec($cmd, $omrOut, $omrCode);

    write_status($jobDir, [
      'status' => 'running',
      'pct' => 88,
      'message' => 'Exporting MusicXML…',
      'error' => null,
      'downloadName' => $downloadName,
    ]);

    $xmlPath = find_best_musicxml($outDir, $safeBase);
    if ($xmlPath === null) {
      $omr = find_first($outDir, 'omr');
      if ($omr !== null) {
        $retryLog = $jobDir . '/audiveris-retry.log';
        $cmd = escapeshellarg(AUDIVERIS_BIN) . ' '
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
      file_put_contents($xmlPath, $xml);
    }

    $finalPath = $jobDir . '/' . $downloadName;
    if (!is_file($finalPath) || realpath($xmlPath) !== realpath($finalPath)) {
      copy($xmlPath, $finalPath);
    }

    write_status($jobDir, [
      'status' => 'done',
      'pct' => 100,
      'message' => 'Done.',
      'error' => null,
      'downloadName' => $downloadName,
      'xml' => $downloadName,
    ]);
  } catch (Throwable $e) {
    write_status($jobDir, [
      'status' => 'error',
      'pct' => 0,
      'message' => 'Conversion failed.',
      'error' => $e->getMessage(),
      'downloadName' => null,
    ]);
  }
}

function filename_slug(string $value): string
{
  $value = trim($value);
  $value = preg_replace('/\s+/', '_', $value) ?? '';
  $value = preg_replace('/[^A-Za-z0-9._-]+/', '', $value) ?? '';
  $value = trim($value, '._-');
  return $value;
}

/** Composer-Full_Title.XML — spaces become underscores. */
function build_download_name(string $title, string $composer, string $fallbackBase): string
{
  $composerSlug = filename_slug($composer);
  $titleSlug = filename_slug($title);
  if ($composerSlug !== '' && $titleSlug !== '') {
    return $composerSlug . '-' . $titleSlug . '.XML';
  }
  if ($titleSlug !== '') {
    return $titleSlug . '.XML';
  }
  if ($composerSlug !== '') {
    return $composerSlug . '.XML';
  }
  $fallback = filename_slug($fallbackBase);
  return ($fallback !== '' ? $fallback : 'score') . '.XML';
}

function estimate_conversion(int $pdfBytes): array
{
  $measures = (int) max(20, (int) round($pdfBytes * MEASURES_PER_PDF_BYTE));
  $seconds = (int) max(25, (int) round($measures * SEC_PER_MEASURE));
  return [
    'estimatedMeasures' => $measures,
    'estimatedSeconds' => $seconds,
  ];
}

function status_payload(string $jobId, array $status): array
{
  return [
    'jobId' => $jobId,
    'status' => $status['status'] ?? 'unknown',
    'pct' => (int) ($status['pct'] ?? 0),
    'message' => (string) ($status['message'] ?? ''),
    'error' => $status['error'] ?? null,
    'downloadName' => $status['downloadName'] ?? null,
    'updatedAt' => $status['updatedAt'] ?? null,
    'estimatedMeasures' => isset($status['estimatedMeasures'])
      ? (int) $status['estimatedMeasures']
      : null,
    'estimatedSeconds' => isset($status['estimatedSeconds'])
      ? (int) $status['estimatedSeconds']
      : null,
    'secPerMeasure' => isset($status['secPerMeasure'])
      ? (float) $status['secPerMeasure']
      : SEC_PER_MEASURE,
  ];
}

function read_status(string $path): array
{
  $raw = (string) file_get_contents($path);
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

function write_status(string $jobDir, array $status): void
{
  // Preserve ETA fields across status updates.
  $existingPath = $jobDir . '/status.json';
  if (is_file($existingPath)) {
    $existing = read_status($existingPath);
    foreach (['estimatedMeasures', 'estimatedSeconds', 'secPerMeasure'] as $key) {
      if (!array_key_exists($key, $status) && array_key_exists($key, $existing)) {
        $status[$key] = $existing[$key];
      }
    }
  }
  $status['updatedAt'] = gmdate('c');
  file_put_contents(
    $jobDir . '/status.json',
    json_encode($status, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)
  );
}

function json_out(array $payload): void
{
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($payload, JSON_UNESCAPED_UNICODE);
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

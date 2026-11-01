<?php
declare(strict_types=1);

/**
 * Background worker: enhance PDF (optional) → Audiveris → patch metadata → status.json
 * Usage: php run_convert_job.php /path/to/job-dir
 */

if (PHP_SAPI !== 'cli') {
  fwrite(STDERR, "CLI only\n");
  exit(1);
}

const AUDIVERIS_BIN = '/usr/local/klavierxml-audiveris/audiveris/bin/pdf2xml.sh';
const ENHANCE_PY = '/usr/local/klavierxml-audiveris/enhance_score_pdf.py';
const PYTHON = '/usr/bin/python3';
const PYDEPS = '/usr/local/klavierxml-audiveris/pydeps';

$jobDir = $argv[1] ?? '';
if ($jobDir === '' || !is_dir($jobDir)) {
  fwrite(STDERR, "Missing job dir\n");
  exit(2);
}

$metaPath = $jobDir . '/meta.json';
if (!is_file($metaPath)) {
  fail_job($jobDir, 'Missing meta.json');
}

$meta = json_decode((string) file_get_contents($metaPath), true);
if (!is_array($meta)) {
  fail_job($jobDir, 'Invalid meta.json');
}

$safeBase = (string) ($meta['safeBase'] ?? 'score');
$pdfName = (string) ($meta['pdf'] ?? ($safeBase . '.pdf'));
$inputPdf = $jobDir . '/' . $pdfName;
$title = trim((string) ($meta['title'] ?? ''));
$composer = trim((string) ($meta['composer'] ?? ''));

if (!is_file($inputPdf)) {
  fail_job($jobDir, 'Uploaded PDF missing.');
}

try {
  write_status($jobDir, [
    'status' => 'running',
    'pct' => 8,
    'message' => 'Preparing score image…',
    'error' => null,
    'downloadName' => $safeBase . '.xml',
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
    'downloadName' => $safeBase . '.xml',
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
    'downloadName' => $safeBase . '.xml',
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

  $finalName = $safeBase . '.xml';
  $finalPath = $jobDir . '/' . $finalName;
  if (realpath($xmlPath) !== realpath($finalPath)) {
    copy($xmlPath, $finalPath);
  }

  write_status($jobDir, [
    'status' => 'done',
    'pct' => 100,
    'message' => 'Done.',
    'error' => null,
    'downloadName' => $finalName,
    'xml' => $finalName,
  ]);
  exit(0);
} catch (Throwable $e) {
  fail_job($jobDir, $e->getMessage());
}

function fail_job(string $jobDir, string $message): void
{
  write_status($jobDir, [
    'status' => 'error',
    'pct' => 0,
    'message' => 'Conversion failed.',
    'error' => $message,
    'downloadName' => null,
  ]);
  fwrite(STDERR, $message . "\n");
  exit(1);
}

function write_status(string $jobDir, array $status): void
{
  $status['updatedAt'] = gmdate('c');
  file_put_contents(
    $jobDir . '/status.json',
    json_encode($status, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)
  );
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

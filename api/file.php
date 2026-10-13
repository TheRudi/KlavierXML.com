<?php
declare(strict_types=1);

$candidates = [
  getenv('KLAVIERXML_CONFIG') ?: '',
  '/Library/WebServer/KlavierXML-data/config.local.php',
  __DIR__ . '/config.local.php',
];
$configFile = '';
foreach ($candidates as $candidate) {
  if ($candidate !== '' && is_file($candidate)) {
    $configFile = $candidate;
    break;
  }
}
if (!is_file($configFile)) {
  http_response_code(500);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'Server config missing.';
  exit;
}

/** @var array $config */
$config = require $configFile;
$id = trim((string) ($_GET['id'] ?? ''));

if ($id === '' || !preg_match('/^[a-zA-Z0-9._-]{1,120}$/', $id)) {
  http_response_code(400);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'Invalid id.';
  exit;
}

$path = rtrim($config['storage_dir'], '/') . '/' . $id . '.mxl';
if (!is_file($path)) {
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'File not found.';
  exit;
}

$filename = $id . '.mxl';
header('Content-Type: application/vnd.recordare.musicxml');
header('Content-Length: ' . (string) filesize($path));
header('Content-Disposition: attachment; filename="' . $filename . '"');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=3600');
readfile($path);

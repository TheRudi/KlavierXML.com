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
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'Server config missing.']);
  exit;
}

/** @var array $config */
$config = require $configFile;

$password = $_SERVER['HTTP_X_ADMIN_PASSWORD'] ?? ($_GET['password'] ?? '');
if (!hash_equals((string) ($config['remove_password'] ?? ''), (string) $password)) {
  http_response_code(403);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'Wrong admin password.']);
  exit;
}

if (!class_exists('ZipArchive')) {
  http_response_code(500);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'Zip support is not available on this server.']);
  exit;
}

try {
  $db = $config['db'];
  $dsn = sprintf(
    'pgsql:host=%s;port=%d;dbname=%s',
    $db['host'],
    (int) $db['port'],
    $db['name']
  );
  $pdo = new PDO($dsn, $db['user'], $db['pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  $stmt = $pdo->query(
    'SELECT id, title, composer, credit, filename, format, bytes, added, license, storage_path, created_at
     FROM exchange_scores
     ORDER BY created_at DESC'
  );
  $rows = $stmt->fetchAll();

  $tmpZip = tempnam(sys_get_temp_dir(), 'kxbackup_');
  if ($tmpZip === false) {
    throw new RuntimeException('Could not create a temporary file.');
  }
  $zipPath = $tmpZip . '.zip';
  rename($tmpZip, $zipPath);

  $zip = new ZipArchive();
  if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    @unlink($zipPath);
    throw new RuntimeException('Could not create the backup zip.');
  }

  $csv = fopen('php://temp', 'r+');
  if ($csv === false) {
    $zip->close();
    @unlink($zipPath);
    throw new RuntimeException('Could not create the CSV catalog.');
  }

  $headers = [
    'id',
    'title',
    'composer',
    'credit',
    'filename',
    'format',
    'bytes',
    'added',
    'license',
    'storage_path',
    'created_at',
    'zip_path',
  ];
  fputcsv($csv, $headers);

  $storageDir = rtrim((string) $config['storage_dir'], '/');
  foreach ($rows as $row) {
    $id = (string) $row['id'];
    $safeName = preg_replace('/[^a-zA-Z0-9._-]+/', '_', (string) ($row['filename'] ?: ($id . '.mxl')));
    if ($safeName === '' || $safeName === '_' || $safeName === '.') {
      $safeName = $id . '.mxl';
    }
    $zipRel = 'files/' . $id . '__' . $safeName;
    $abs = $storageDir . '/' . $id . '.mxl';
    if (is_file($abs)) {
      $zip->addFile($abs, $zipRel);
    } else {
      $zipRel = '';
    }

    fputcsv($csv, [
      $row['id'],
      $row['title'],
      $row['composer'],
      $row['credit'] ?? '',
      $row['filename'],
      $row['format'] ?? 'mxl',
      (int) ($row['bytes'] ?? 0),
      $row['added'] ?? '',
      $row['license'] ?? '',
      $row['storage_path'] ?? '',
      $row['created_at'] ?? '',
      $zipRel,
    ]);
  }

  rewind($csv);
  $csvBody = stream_get_contents($csv);
  fclose($csv);
  $zip->addFromString('scores.csv', $csvBody === false ? '' : $csvBody);
  $zip->addFromString(
    'README.txt',
    "KlavierXML exchange backup\n"
      . 'Created: ' . gmdate('c') . " UTC\n"
      . 'Scores: ' . count($rows) . "\n"
      . "scores.csv lists every catalog field.\n"
      . "files/ holds the .mxl score binaries.\n"
  );
  $zip->close();

  $filename = 'klavierxml-exchange-backup-' . gmdate('Ymd-His') . '.zip';
  $size = filesize($zipPath);
  header('Content-Type: application/zip');
  header('Content-Disposition: attachment; filename="' . $filename . '"');
  header('X-Content-Type-Options: nosniff');
  header('Cache-Control: no-store');
  if ($size !== false) {
    header('Content-Length: ' . (string) $size);
  }
  readfile($zipPath);
  @unlink($zipPath);
} catch (Throwable $e) {
  if (!headers_sent()) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
  }
  echo json_encode(['error' => $e->getMessage()]);
}

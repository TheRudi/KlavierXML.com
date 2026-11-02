<?php
/**
 * Copy to config.local.php on the server and fill in credentials.
 * config.local.php must not be web-accessible (.htaccess denies *.local.php).
 */
return [
  'db' => [
    'host' => '127.0.0.1',
    'port' => 5432,
    'name' => 'klavierxml',
    'user' => 'postgres',
    'pass' => 'CHANGE_ME',
  ],
  'storage_dir' => __DIR__ . '/../exchange-data/files',
  'max_files' => 10000,
  'max_mxl_bytes' => 100 * 1024,
  'remove_password' => 'CHANGE_ME',
];

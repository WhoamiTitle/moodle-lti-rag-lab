<?php
define('CLI_SCRIPT', true);
require '/var/www/html/config.php';

if (empty($CFG->version) || !$DB->record_exists('user', ['id' => 2, 'deleted' => 0])) {
    exit(1);
}
fwrite(STDOUT, "Moodle database and installation are ready.\n");

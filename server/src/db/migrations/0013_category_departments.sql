-- Departments (with short names, and other languages) under each college,
-- which search matches. Only the column: the lists come in through the admin
-- category form or bulk import.
ALTER TABLE `categories` ADD `departments` text DEFAULT '[]' NOT NULL;

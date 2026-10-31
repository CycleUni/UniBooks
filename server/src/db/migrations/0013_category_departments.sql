-- Departments (with short names) under each college; search matches them. The
-- default colleges get the default lists; a row an admin has already given
-- departments keeps them.
ALTER TABLE `categories` ADD `departments` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"經濟學系","aliases":["經濟"]},{"name":"會計學系","aliases":["會計"]},{"name":"企業管理學系","aliases":["企管"]},{"name":"財務金融學系","aliases":["財金"]},{"name":"國際企業學系","aliases":["國企"]},{"name":"資訊管理學系","aliases":["資管"]},{"name":"統計學系","aliases":["統計"]},{"name":"風險管理與保險學系","aliases":["風保","保險"]},{"name":"行銷學系","aliases":["行銷"]}]' WHERE `slug` = 'management' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"機械工程學系","aliases":["機械","機工"]},{"name":"土木工程學系","aliases":["土木"]},{"name":"化學工程學系","aliases":["化工"]},{"name":"材料科學與工程學系","aliases":["材料"]},{"name":"工業工程與管理學系","aliases":["工工","工管"]},{"name":"環境工程學系","aliases":["環工"]},{"name":"航空太空工程學系","aliases":["航太"]},{"name":"生物醫學工程學系","aliases":["醫工"]},{"name":"工程科學系","aliases":["工科"]}]' WHERE `slug` = 'engineering' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"數學系","aliases":["數學"]},{"name":"應用數學系","aliases":["應數"]},{"name":"物理學系","aliases":["物理"]},{"name":"化學系","aliases":["化學"]},{"name":"生命科學系","aliases":["生科"]},{"name":"地球科學系","aliases":["地科"]},{"name":"大氣科學系","aliases":["大氣"]},{"name":"地理學系","aliases":["地理"]},{"name":"心理學系","aliases":["心理"]}]' WHERE `slug` = 'science' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"中國文學系","aliases":["中文"]},{"name":"外國語文學系","aliases":["外文"]},{"name":"英國語文學系","aliases":["英文"]},{"name":"日本語文學系","aliases":["日文"]},{"name":"歷史學系","aliases":["歷史"]},{"name":"哲學系","aliases":["哲學"]},{"name":"人類學系","aliases":["人類"]},{"name":"圖書資訊學系","aliases":["圖資"]},{"name":"台灣文學系","aliases":["台文"]},{"name":"戲劇學系","aliases":["戲劇"]}]' WHERE `slug` = 'liberal-arts' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"醫學系","aliases":["醫學"]},{"name":"牙醫學系","aliases":["牙醫"]},{"name":"藥學系","aliases":["藥學"]},{"name":"護理學系","aliases":["護理"]},{"name":"醫學檢驗暨生物技術學系","aliases":["醫技"]},{"name":"物理治療學系","aliases":["物治"]},{"name":"職能治療學系","aliases":["職治"]},{"name":"公共衛生學系","aliases":["公衛"]}]' WHERE `slug` = 'medicine' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"電機工程學系","aliases":["電機"]},{"name":"資訊工程學系","aliases":["資工"]},{"name":"電子工程學系","aliases":["電子"]},{"name":"光電工程學系","aliases":["光電"]},{"name":"通訊工程學系","aliases":["通訊"]}]' WHERE `slug` = 'eecs' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"法律學系","aliases":["法律"]},{"name":"財經法律學系","aliases":["財法"]}]' WHERE `slug` = 'law' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"政治學系","aliases":["政治"]},{"name":"社會學系","aliases":["社會"]},{"name":"社會工作學系","aliases":["社工"]},{"name":"公共行政學系","aliases":["公行"]},{"name":"新聞學系","aliases":["新聞"]},{"name":"大眾傳播學系","aliases":["大傳"]}]' WHERE `slug` = 'social-sciences' AND `departments` = '[]';

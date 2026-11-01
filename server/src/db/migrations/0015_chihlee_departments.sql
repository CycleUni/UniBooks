-- 致理科技大學's departments, which only 企業管理, 財務金融 and 資訊管理 covered:
-- each is appended to its college unless that college already lists it, so an
-- admin's list keeps its own entries. The four colleges imported before
-- departments existed (still []) get their whole list first.
UPDATE `categories` SET `departments` = '[{"name":"農藝學系","aliases":["農藝"],"translations":{"en":{"name":"Agronomy","aliases":[]}}},{"name":"園藝學系","aliases":["園藝"],"translations":{"en":{"name":"Horticulture","aliases":[]}}},{"name":"森林學系","aliases":["森林"],"translations":{"en":{"name":"Forestry","aliases":[]}}},{"name":"動物科學技術學系","aliases":["動科"],"translations":{"en":{"name":"Animal Science and Technology","aliases":[]}}},{"name":"植物病理與微生物學系","aliases":["植微"],"translations":{"en":{"name":"Plant Pathology and Microbiology","aliases":[]}}},{"name":"食品科學系","aliases":["食科"],"translations":{"en":{"name":"Food Science","aliases":[]}}},{"name":"生物產業機電工程學系","aliases":["生機"],"translations":{"en":{"name":"Bio-Industrial Mechatronics Engineering","aliases":[]}}},{"name":"農業經濟學系","aliases":["農經"],"translations":{"en":{"name":"Agricultural Economics","aliases":[]}}}]' WHERE `slug` = 'agriculture' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"美術學系","aliases":["美術"],"translations":{"en":{"name":"Fine Arts","aliases":[]}}},{"name":"音樂學系","aliases":["音樂"],"translations":{"en":{"name":"Music","aliases":[]}}},{"name":"設計學系","aliases":["設計"],"translations":{"en":{"name":"Design","aliases":[]}}},{"name":"視覺傳達設計學系","aliases":["視傳"],"translations":{"en":{"name":"Visual Communication Design","aliases":[]}}},{"name":"工業設計學系","aliases":["工設"],"translations":{"en":{"name":"Industrial Design","aliases":[]}}},{"name":"建築學系","aliases":["建築"],"translations":{"en":{"name":"Architecture","aliases":[]}}},{"name":"多媒體設計系","aliases":["多媒體","多媒"],"translations":{"en":{"name":"Multimedia Design","aliases":[]}}}]' WHERE `slug` = 'arts-design' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"教育學系","aliases":["教育"],"translations":{"en":{"name":"Education","aliases":[]}}},{"name":"特殊教育學系","aliases":["特教"],"translations":{"en":{"name":"Special Education","aliases":[]}}},{"name":"幼兒教育學系","aliases":["幼教"],"translations":{"en":{"name":"Early Childhood Education","aliases":[]}}},{"name":"體育學系","aliases":["體育"],"translations":{"en":{"name":"Physical Education","aliases":["PE"]}}},{"name":"社會教育學系","aliases":["社教"],"translations":{"en":{"name":"Social and Public Affairs Education","aliases":[]}}},{"name":"教育心理與輔導學系","aliases":["教心"],"translations":{"en":{"name":"Educational Psychology and Counseling","aliases":[]}}}]' WHERE `slug` = 'education' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = '[{"name":"牙醫學系","aliases":["牙醫"],"translations":{"en":{"name":"Dentistry","aliases":[]}}},{"name":"口腔衛生學系","aliases":["口衛"],"translations":{"en":{"name":"Oral Hygiene","aliases":[]}}},{"name":"牙體技術學系","aliases":["牙技"],"translations":{"en":{"name":"Dental Technology","aliases":[]}}}]' WHERE `slug` = 'dentistry' AND `departments` = '[]';
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"會計資訊系","aliases":["會資"],"translations":{"en":{"name":"Accounting Information","aliases":[]}}}'))
WHERE `slug` = 'management' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('會計資訊系', '會計資訊學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"行銷與流通管理系","aliases":["行流"],"translations":{"en":{"name":"Marketing and Logistics Management","aliases":[]}}}'))
WHERE `slug` = 'management' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('行銷與流通管理系', '行銷與流通管理學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"休閒遊憩管理系","aliases":["休閒","休遊"],"translations":{"en":{"name":"Leisure and Recreation Management","aliases":[]}}}'))
WHERE `slug` = 'management' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('休閒遊憩管理系', '休閒遊憩管理學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"國際貿易系","aliases":["國貿"],"translations":{"en":{"name":"International Trade","aliases":[]}}}'))
WHERE `slug` = 'management' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('國際貿易系', '國際貿易學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"商務科技應用系","aliases":["商務科技管理系","商科"],"translations":{"en":{"name":"Commerce Technology Applications","aliases":["Commerce Technology and Management"]}}}'))
WHERE `slug` = 'management' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('商務科技應用系', '商務科技應用學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"應用英語系","aliases":["應英"],"translations":{"en":{"name":"Applied English","aliases":[]}}}'))
WHERE `slug` = 'liberal-arts' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('應用英語系', '應用英語學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"應用日語系","aliases":["應日"],"translations":{"en":{"name":"Applied Japanese","aliases":[]}}}'))
WHERE `slug` = 'liberal-arts' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('應用日語系', '應用日語學系'));
--> statement-breakpoint
UPDATE `categories` SET `departments` = json_insert(`departments`, '$[#]', json('{"name":"多媒體設計系","aliases":["多媒體","多媒"],"translations":{"en":{"name":"Multimedia Design","aliases":[]}}}'))
WHERE `slug` = 'arts-design' AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`departments`) WHERE json_extract(value, '$.name') IN ('多媒體設計系', '多媒體設計學系'));

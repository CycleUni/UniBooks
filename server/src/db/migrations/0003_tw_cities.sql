-- Taiwan's cities: schools point at them and no admin page creates them, so
-- without these the school bulk import rejects every row (admin.errSchoolCityUnknown).
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'TPE', 'Taipei City', '{"zh-TW":{"name":"臺北市"},"zh-HK":{"name":"台北市"}}', 1);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'NWT', 'New Taipei City', '{"zh-TW":{"name":"新北市"},"zh-HK":{"name":"新北市"}}', 2);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'KEE', 'Keelung City', '{"zh-TW":{"name":"基隆市"},"zh-HK":{"name":"基隆市"}}', 3);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'TAO', 'Taoyuan City', '{"zh-TW":{"name":"桃園市"},"zh-HK":{"name":"桃園市"}}', 4);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'HSZ', 'Hsinchu City', '{"zh-TW":{"name":"新竹市"},"zh-HK":{"name":"新竹市"}}', 5);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'HSQ', 'Hsinchu County', '{"zh-TW":{"name":"新竹縣"},"zh-HK":{"name":"新竹縣"}}', 6);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'MIA', 'Miaoli County', '{"zh-TW":{"name":"苗栗縣"},"zh-HK":{"name":"苗栗縣"}}', 7);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'TXG', 'Taichung City', '{"zh-TW":{"name":"臺中市"},"zh-HK":{"name":"台中市"}}', 8);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'CHA', 'Changhua County', '{"zh-TW":{"name":"彰化縣"},"zh-HK":{"name":"彰化縣"}}', 9);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'NAN', 'Nantou County', '{"zh-TW":{"name":"南投縣"},"zh-HK":{"name":"南投縣"}}', 10);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'YUN', 'Yunlin County', '{"zh-TW":{"name":"雲林縣"},"zh-HK":{"name":"雲林縣"}}', 11);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'CYI', 'Chiayi City', '{"zh-TW":{"name":"嘉義市"},"zh-HK":{"name":"嘉義市"}}', 12);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'CYQ', 'Chiayi County', '{"zh-TW":{"name":"嘉義縣"},"zh-HK":{"name":"嘉義縣"}}', 13);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'TNN', 'Tainan City', '{"zh-TW":{"name":"臺南市"},"zh-HK":{"name":"台南市"}}', 14);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'KHH', 'Kaohsiung City', '{"zh-TW":{"name":"高雄市"},"zh-HK":{"name":"高雄市"}}', 15);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'PIF', 'Pingtung County', '{"zh-TW":{"name":"屏東縣"},"zh-HK":{"name":"屏東縣"}}', 16);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'ILA', 'Yilan County', '{"zh-TW":{"name":"宜蘭縣"},"zh-HK":{"name":"宜蘭縣"}}', 17);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'HUA', 'Hualien County', '{"zh-TW":{"name":"花蓮縣"},"zh-HK":{"name":"花蓮縣"}}', 18);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'TTT', 'Taitung County', '{"zh-TW":{"name":"臺東縣"},"zh-HK":{"name":"台東縣"}}', 19);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'PEN', 'Penghu County', '{"zh-TW":{"name":"澎湖縣"},"zh-HK":{"name":"澎湖縣"}}', 20);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'KIN', 'Kinmen County', '{"zh-TW":{"name":"金門縣"},"zh-HK":{"name":"金門縣"}}', 21);
--> statement-breakpoint
INSERT OR IGNORE INTO cities (region_code, code, name, translations, sort_order) VALUES ('TW', 'LIE', 'Lienchiang County', '{"zh-TW":{"name":"連江縣"},"zh-HK":{"name":"連江縣"}}', 22);

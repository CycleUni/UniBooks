import { eq } from 'drizzle-orm';
import { categories, cities, type Database } from '../../db';
import type { Department } from '../../lib/json';

/**
 * Default categories and cities. The same data
 * is in src/db/seed.sql for a fresh database; a region created through the
 * admin API gets its categories from seedDefaultCategories().
 */

interface DefaultCategory {
  slug: string;
  title: string;
  description: string;
  'zh-TW': [string, string];
  'zh-HK': [string, string];
  'en-HK': [string, string];
  departments: Department[];
}

/**
 * A department's full name and short names, then its English name and short
 * names; the same list serves every region.
 */
const dept = (name: string, aliases: string[], en: string, ...enAliases: string[]): Department => ({
  name,
  aliases,
  translations: { en: { name: en, aliases: enAliases } },
});

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  {
    slug: 'management',
    title: 'College of Management',
    description: 'Economics, Accounting, Business Administration',
    'zh-TW': ['商管學院', '經濟、會計、企管'],
    'zh-HK': ['工商管理學院', '會計、金融、經濟'],
    'en-HK': ['Faculty of Business Administration', 'Accounting, Finance, Economics'],
    departments: [
      dept('經濟學系', ['經濟'], 'Economics', 'Econ'),
      dept('會計學系', ['會計'], 'Accounting'),
      dept('企業管理學系', ['企管'], 'Business Administration'),
      dept('財務金融學系', ['財金'], 'Finance'),
      dept('國際企業學系', ['國企'], 'International Business', 'IB'),
      dept('資訊管理學系', ['資管'], 'Information Management', 'IM', 'MIS'),
      dept('統計學系', ['統計'], 'Statistics', 'Stats'),
      dept('風險管理與保險學系', ['風保', '保險'], 'Risk Management and Insurance', 'RMI'),
      dept('行銷學系', ['行銷'], 'Marketing'),
    ],
  },
  {
    slug: 'engineering',
    title: 'College of Engineering',
    description: 'Mechanical, Civil, Chemical Engineering',
    'zh-TW': ['工學院', '機械、土木、化工'],
    'zh-HK': ['工程學院', '機械工程、土木工程、化學工程'],
    'en-HK': ['Faculty of Engineering', 'Mechanical, Civil and Chemical Engineering'],
    departments: [
      dept('機械工程學系', ['機械', '機工'], 'Mechanical Engineering', 'ME'),
      dept('土木工程學系', ['土木'], 'Civil Engineering', 'CE'),
      dept('化學工程學系', ['化工'], 'Chemical Engineering', 'ChemE'),
      dept('材料科學與工程學系', ['材料'], 'Materials Science and Engineering', 'MSE'),
      dept('工業工程與管理學系', ['工工', '工管'], 'Industrial Engineering and Management', 'IEM'),
      dept('環境工程學系', ['環工'], 'Environmental Engineering'),
      dept('航空太空工程學系', ['航太'], 'Aerospace Engineering'),
      dept('生物醫學工程學系', ['醫工'], 'Biomedical Engineering', 'BME'),
      dept('工程科學系', ['工科'], 'Engineering Science'),
    ],
  },
  {
    slug: 'science',
    title: 'College of Science',
    description: 'Mathematics, Physics, Chemistry',
    'zh-TW': ['理學院', '數學、物理、化學'],
    'zh-HK': ['理學院', '數學、物理、化學'],
    'en-HK': ['Faculty of Science', 'Mathematics, Physics, Chemistry'],
    departments: [
      dept('數學系', ['數學'], 'Mathematics', 'Math'),
      dept('應用數學系', ['應數'], 'Applied Mathematics'),
      dept('物理學系', ['物理'], 'Physics'),
      dept('化學系', ['化學'], 'Chemistry'),
      dept('生命科學系', ['生科'], 'Life Science'),
      dept('地球科學系', ['地科'], 'Earth Sciences'),
      dept('大氣科學系', ['大氣'], 'Atmospheric Sciences'),
      dept('地理學系', ['地理'], 'Geography'),
      dept('心理學系', ['心理'], 'Psychology'),
    ],
  },
  {
    slug: 'liberal-arts',
    title: 'College of Liberal Arts',
    description: 'Foreign Languages, Chinese, History',
    'zh-TW': ['文學院', '外文、中文、歷史'],
    'zh-HK': ['文學院', '英文、中文、歷史'],
    'en-HK': ['Faculty of Arts', 'English, Chinese, History'],
    departments: [
      dept('中國文學系', ['中文'], 'Chinese Literature'),
      dept('外國語文學系', ['外文'], 'Foreign Languages and Literatures'),
      dept('英國語文學系', ['英文'], 'English'),
      dept('日本語文學系', ['日文'], 'Japanese'),
      dept('歷史學系', ['歷史'], 'History'),
      dept('哲學系', ['哲學'], 'Philosophy'),
      dept('人類學系', ['人類'], 'Anthropology'),
      dept('圖書資訊學系', ['圖資'], 'Library and Information Science', 'LIS'),
      dept('台灣文學系', ['台文'], 'Taiwanese Literature'),
      dept('戲劇學系', ['戲劇'], 'Drama and Theatre'),
    ],
  },
  {
    slug: 'medicine',
    title: 'College of Medicine',
    description: 'Medicine, Nursing, Pharmacy',
    'zh-TW': ['醫學院', '醫學、護理、藥學'],
    'zh-HK': ['醫學院', '醫學、護理、藥劑'],
    'en-HK': ['Faculty of Medicine', 'Medicine, Nursing, Pharmacy'],
    departments: [
      dept('醫學系', ['醫學'], 'Medicine'),
      dept('牙醫學系', ['牙醫'], 'Dentistry'),
      dept('藥學系', ['藥學'], 'Pharmacy'),
      dept('護理學系', ['護理'], 'Nursing'),
      dept('醫學檢驗暨生物技術學系', ['醫技'], 'Medical Laboratory Science and Biotechnology'),
      dept('物理治療學系', ['物治'], 'Physical Therapy', 'PT'),
      dept('職能治療學系', ['職治'], 'Occupational Therapy', 'OT'),
      dept('公共衛生學系', ['公衛'], 'Public Health'),
    ],
  },
  {
    slug: 'eecs',
    title: 'College of EECS',
    description: 'Electrical Engineering, Computer Science',
    'zh-TW': ['電資學院', '電機、資工'],
    'zh-HK': ['電機及計算機學院', '電子工程、計算機科學'],
    'en-HK': ['Faculty of Electrical Engineering and Computer Science', 'Electronic Engineering, Computer Science'],
    departments: [
      dept('電機工程學系', ['電機'], 'Electrical Engineering', 'EE'),
      dept('資訊工程學系', ['資工'], 'Computer Science and Information Engineering', 'CSIE', 'CS'),
      dept('電子工程學系', ['電子'], 'Electronic Engineering'),
      dept('光電工程學系', ['光電'], 'Photonics'),
      dept('通訊工程學系', ['通訊'], 'Communication Engineering'),
    ],
  },
  {
    slug: 'law',
    title: 'College of Law',
    description: 'Department of Law',
    'zh-TW': ['法學院', '法律學系'],
    'zh-HK': ['法律學院', '法律'],
    'en-HK': ['Faculty of Law', 'Law'],
    departments: [dept('法律學系', ['法律'], 'Law'), dept('財經法律學系', ['財法'], 'Financial and Economic Law')],
  },
  {
    slug: 'social-sciences',
    title: 'College of Social Sciences',
    description: 'Political Science, Sociology, Social Work',
    'zh-TW': ['社科院', '政治、社會、社工'],
    'zh-HK': ['社會科學院', '政治、社會學、社會工作'],
    'en-HK': ['Faculty of Social Sciences', 'Politics, Sociology, Social Work'],
    departments: [
      dept('政治學系', ['政治'], 'Political Science'),
      dept('社會學系', ['社會'], 'Sociology'),
      dept('社會工作學系', ['社工'], 'Social Work'),
      dept('公共行政學系', ['公行'], 'Public Administration'),
      dept('新聞學系', ['新聞'], 'Journalism'),
      dept('大眾傳播學系', ['大傳'], 'Mass Communication'),
    ],
  },
];

/** Category column values for one default entry. */
export function categoryDefaults(item: DefaultCategory, sortOrder: number, regionCode: string) {
  const [title, description] = regionCode === 'HK' ? item['en-HK'] : [item.title, item.description];
  return {
    slug: item.slug,
    title,
    description,
    translations: JSON.stringify({
      'zh-TW': { title: item['zh-TW'][0], description: item['zh-TW'][1] },
      'zh-HK': { title: item['zh-HK'][0], description: item['zh-HK'][1] },
    }),
    departments: JSON.stringify(item.departments),
    sortOrder,
    isActive: 1,
  };
}

/** Give `regionCode` the default categories if it has none at all. */
export async function seedDefaultCategories(db: Database, regionCode: string): Promise<number> {
  const [any] = await db.select({ id: categories.id }).from(categories).where(eq(categories.regionCode, regionCode)).limit(1);
  if (any) return 0;
  await db.insert(categories).values(DEFAULT_CATEGORIES.map((item, i) => ({ regionCode, ...categoryDefaults(item, i + 1, regionCode) })));
  return DEFAULT_CATEGORIES.length;
}

/** code, English name, zh-TW name, zh-HK name. */
export const DEFAULT_CITIES: Record<string, [string, string, string, string][]> = {
  TW: [
    ['TPE', 'Taipei City', '臺北市', '台北市'],
    ['NWT', 'New Taipei City', '新北市', '新北市'],
    ['KEE', 'Keelung City', '基隆市', '基隆市'],
    ['TAO', 'Taoyuan City', '桃園市', '桃園市'],
    ['HSZ', 'Hsinchu City', '新竹市', '新竹市'],
    ['HSQ', 'Hsinchu County', '新竹縣', '新竹縣'],
    ['MIA', 'Miaoli County', '苗栗縣', '苗栗縣'],
    ['TXG', 'Taichung City', '臺中市', '台中市'],
    ['CHA', 'Changhua County', '彰化縣', '彰化縣'],
    ['NAN', 'Nantou County', '南投縣', '南投縣'],
    ['YUN', 'Yunlin County', '雲林縣', '雲林縣'],
    ['CYI', 'Chiayi City', '嘉義市', '嘉義市'],
    ['CYQ', 'Chiayi County', '嘉義縣', '嘉義縣'],
    ['TNN', 'Tainan City', '臺南市', '台南市'],
    ['KHH', 'Kaohsiung City', '高雄市', '高雄市'],
    ['PIF', 'Pingtung County', '屏東縣', '屏東縣'],
    ['ILA', 'Yilan County', '宜蘭縣', '宜蘭縣'],
    ['HUA', 'Hualien County', '花蓮縣', '花蓮縣'],
    ['TTT', 'Taitung County', '臺東縣', '台東縣'],
    ['PEN', 'Penghu County', '澎湖縣', '澎湖縣'],
    ['KIN', 'Kinmen County', '金門縣', '金門縣'],
    ['LIE', 'Lienchiang County', '連江縣', '連江縣'],
  ],
  HK: [
    ['HKI', 'Hong Kong Island', '香港島', '港島'],
    ['KLN', 'Kowloon', '九龍', '九龍'],
    ['NT', 'New Territories', '新界', '新界'],
  ],
};

/** Give `regionCode` its default cities if it has none. */
export async function seedDefaultCities(db: Database, regionCode: string): Promise<number> {
  const entries = DEFAULT_CITIES[regionCode] ?? [];
  if (!entries.length) return 0;
  const [any] = await db.select({ id: cities.id }).from(cities).where(eq(cities.regionCode, regionCode)).limit(1);
  if (any) return 0;
  const rows = entries.map(([code, name, zhTw, zhHk], i) => ({
    regionCode,
    code,
    name,
    translations: JSON.stringify({ 'zh-TW': { name: zhTw }, 'zh-HK': { name: zhHk } }),
    sortOrder: i + 1,
  }));
  // D1 binds at most 100 parameters per statement.
  const chunks = [];
  for (let i = 0; i < rows.length; i += 15) chunks.push(db.insert(cities).values(rows.slice(i, i + 15)));
  await db.batch(chunks as [(typeof chunks)[0], ...typeof chunks]);
  return entries.length;
}

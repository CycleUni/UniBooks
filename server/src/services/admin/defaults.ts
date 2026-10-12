import { eq } from 'drizzle-orm';
import { categories, cities, type Database } from '../../db';

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
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  {
    slug: 'management',
    title: 'College of Management',
    description: 'Economics, Accounting, Business Administration',
    'zh-TW': ['商管學院', '經濟、會計、企管'],
    'zh-HK': ['工商管理學院', '會計、金融、經濟'],
    'en-HK': ['Faculty of Business Administration', 'Accounting, Finance, Economics'],
  },
  {
    slug: 'engineering',
    title: 'College of Engineering',
    description: 'Mechanical, Civil, Chemical Engineering',
    'zh-TW': ['工學院', '機械、土木、化工'],
    'zh-HK': ['工程學院', '機械工程、土木工程、化學工程'],
    'en-HK': ['Faculty of Engineering', 'Mechanical, Civil and Chemical Engineering'],
  },
  {
    slug: 'science',
    title: 'College of Science',
    description: 'Mathematics, Physics, Chemistry',
    'zh-TW': ['理學院', '數學、物理、化學'],
    'zh-HK': ['理學院', '數學、物理、化學'],
    'en-HK': ['Faculty of Science', 'Mathematics, Physics, Chemistry'],
  },
  {
    slug: 'liberal-arts',
    title: 'College of Liberal Arts',
    description: 'Foreign Languages, Chinese, History',
    'zh-TW': ['文學院', '外文、中文、歷史'],
    'zh-HK': ['文學院', '英文、中文、歷史'],
    'en-HK': ['Faculty of Arts', 'English, Chinese, History'],
  },
  {
    slug: 'medicine',
    title: 'College of Medicine',
    description: 'Medicine, Nursing, Pharmacy',
    'zh-TW': ['醫學院', '醫學、護理、藥學'],
    'zh-HK': ['醫學院', '醫學、護理、藥劑'],
    'en-HK': ['Faculty of Medicine', 'Medicine, Nursing, Pharmacy'],
  },
  {
    slug: 'eecs',
    title: 'College of EECS',
    description: 'Electrical Engineering, Computer Science',
    'zh-TW': ['電資學院', '電機、資工'],
    'zh-HK': ['電機及計算機學院', '電子工程、計算機科學'],
    'en-HK': ['Faculty of Electrical Engineering and Computer Science', 'Electronic Engineering, Computer Science'],
  },
  {
    slug: 'law',
    title: 'College of Law',
    description: 'Department of Law',
    'zh-TW': ['法學院', '法律學系'],
    'zh-HK': ['法律學院', '法律'],
    'en-HK': ['Faculty of Law', 'Law'],
  },
  {
    slug: 'social-sciences',
    title: 'College of Social Sciences',
    description: 'Political Science, Sociology, Social Work',
    'zh-TW': ['社科院', '政治、社會、社工'],
    'zh-HK': ['社會科學院', '政治、社會學、社會工作'],
    'en-HK': ['Faculty of Social Sciences', 'Politics, Sociology, Social Work'],
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

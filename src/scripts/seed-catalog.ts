// Enriches the catalog of an already-bootstrapped store with more categories and products.
// Separate from seed.ts (which tests and the quick-start flow depend on staying minimal).
// Safe to re-run: every insert is ON CONFLICT DO NOTHING against fixed UUIDs.
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { one, postgres, type Database } from '../db.js';
import { assert } from '../core.js';
import { seedIds } from './seed.js';

const category = (n: number, ru: string, ky: string, en: string, sort: number) => ({
  id: `20000000-0000-4000-8000-00000000000${n}`,
  name: { ru, ky, en },
  sort,
});
const categories = [
  category(2, 'Овощи и фрукты', 'Жашылча-жемиш', 'Vegetables & fruits', 1),
  category(3, 'Молочные продукты', 'Сүт азыктары', 'Dairy', 2),
  category(4, 'Хлеб и выпечка', 'Нан азыктары', 'Bakery', 3),
  category(5, 'Мясо и птица', 'Эт жана канаттуулар', 'Meat & poultry', 4),
  category(6, 'Напитки', 'Суусундуктар', 'Beverages', 5),
  category(7, 'Снеки и сладости', 'Таттуулар жана чипстер', 'Snacks & sweets', 6),
  category(8, 'Бытовая химия', 'Тиричилик химиясы', 'Household', 7),
];

type Nutrition = { calories?: number; protein?: number; fat?: number; carbohydrates?: number };
const product = (
  n: number,
  categoryIndex: number,
  ru: string,
  ky: string,
  en: string,
  unit: string,
  price: number,
  stock: number,
  nutrition: Nutrition = {},
) => ({
  id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  categoryId: categories[categoryIndex].id,
  name: { ru, ky, en },
  unit,
  price: price * 100,
  stock,
  nutrition,
});
const products = [
  product(4, 0, 'Помидоры', 'Помидор', 'Tomatoes', '1 кг', 90, 120, {
    calories: 18,
    protein: 0.9,
    fat: 0.2,
    carbohydrates: 3.9,
  }),
  product(5, 0, 'Огурцы', 'Бадыраң', 'Cucumbers', '1 кг', 70, 110, {
    calories: 15,
    protein: 0.7,
    fat: 0.1,
    carbohydrates: 3.6,
  }),
  product(6, 0, 'Картофель', 'Картошка', 'Potatoes', '1 кг', 35, 150, {
    calories: 77,
    protein: 2,
    fat: 0.1,
    carbohydrates: 17,
  }),
  product(7, 0, 'Морковь', 'Сабиз', 'Carrots', '1 кг', 40, 130, {
    calories: 41,
    protein: 0.9,
    fat: 0.2,
    carbohydrates: 10,
  }),
  product(8, 0, 'Яблоки', 'Алма', 'Apples', '1 кг', 110, 90, {
    calories: 52,
    protein: 0.3,
    fat: 0.2,
    carbohydrates: 14,
  }),
  product(9, 0, 'Бананы', 'Банан', 'Bananas', '1 кг', 95, 85, {
    calories: 89,
    protein: 1.1,
    fat: 0.3,
    carbohydrates: 23,
  }),
  product(10, 0, 'Лук репчатый', 'Пияз', 'Onions', '1 кг', 30, 140, {
    calories: 40,
    protein: 1.1,
    fat: 0.1,
    carbohydrates: 9,
  }),

  product(11, 1, 'Молоко 3.2%', 'Сүт', 'Milk 3.2%', '1 л', 85, 70, {
    calories: 60,
    protein: 3,
    fat: 3.2,
    carbohydrates: 4.7,
  }),
  product(12, 1, 'Кефир', 'Кефир', 'Kefir', '900 мл', 75, 60, { calories: 56, protein: 3, fat: 3.2, carbohydrates: 4 }),
  product(13, 1, 'Сметана 20%', 'Каймак', 'Sour cream 20%', '400 г', 120, 55, {
    calories: 206,
    protein: 2.8,
    fat: 20,
    carbohydrates: 3.2,
  }),
  product(14, 1, 'Творог 5%', 'Сүзмө', 'Cottage cheese 5%', '350 г', 150, 45, {
    calories: 121,
    protein: 17,
    fat: 5,
    carbohydrates: 3,
  }),
  product(15, 1, 'Сыр Гауда', 'Гауда бышымы', 'Gouda cheese', '300 г', 320, 40, {
    calories: 356,
    protein: 25,
    fat: 27,
    carbohydrates: 2.2,
  }),
  product(16, 1, 'Сливочное масло 82.5%', 'Сары май', 'Butter 82.5%', '180 г', 180, 50, {
    calories: 748,
    protein: 0.5,
    fat: 82.5,
    carbohydrates: 0.8,
  }),

  product(17, 2, 'Хлеб белый', 'Ак нан', 'White bread', '1 шт.', 25, 100, {
    calories: 265,
    protein: 9,
    fat: 3.2,
    carbohydrates: 49,
  }),
  product(18, 2, 'Лепёшка', 'Токоч', 'Lepyoshka flatbread', '1 шт.', 30, 90, {
    calories: 250,
    protein: 8,
    fat: 2,
    carbohydrates: 50,
  }),
  product(19, 2, 'Багет', 'Багет', 'Baguette', '1 шт.', 45, 60, {
    calories: 274,
    protein: 9,
    fat: 2,
    carbohydrates: 53,
  }),
  product(20, 2, 'Круассан', 'Круассан', 'Croissant', '1 шт.', 60, 40, {
    calories: 406,
    protein: 8.2,
    fat: 21,
    carbohydrates: 46,
  }),
  product(21, 2, 'Самса с мясом', 'Эттүү самса', 'Beef samsa', '1 шт.', 50, 70, {
    calories: 290,
    protein: 12,
    fat: 16,
    carbohydrates: 24,
  }),

  product(22, 3, 'Куриное филе', 'Тоок эти (филе)', 'Chicken fillet', '1 кг', 450, 60, {
    calories: 165,
    protein: 31,
    fat: 3.6,
    carbohydrates: 0,
  }),
  product(23, 3, 'Говядина (вырезка)', 'Уй эти', 'Beef tenderloin', '1 кг', 650, 35, {
    calories: 250,
    protein: 26,
    fat: 15,
    carbohydrates: 0,
  }),
  product(24, 3, 'Баранина', 'Кой эти', 'Lamb', '1 кг', 700, 25, {
    calories: 294,
    protein: 25,
    fat: 21,
    carbohydrates: 0,
  }),
  product(25, 3, 'Фарш говяжий', 'Уй эти фарш', 'Ground beef', '500 г', 320, 50, {
    calories: 254,
    protein: 17,
    fat: 20,
    carbohydrates: 0,
  }),
  product(26, 3, 'Куриные яйца С1, 10 шт.', 'Тоок жумурткасы', 'Eggs C1, 10 pcs', '10 шт.', 110, 100, {
    calories: 143,
    protein: 13,
    fat: 9.5,
    carbohydrates: 0.7,
  }),

  product(27, 4, 'Вода негазированная', 'Суу (газсыз)', 'Still water', '1.5 л', 35, 150, { calories: 0 }),
  product(28, 4, 'Сок яблочный', 'Алма ширеси', 'Apple juice', '1 л', 95, 80, {
    calories: 46,
    protein: 0.1,
    fat: 0.1,
    carbohydrates: 11,
  }),
  product(29, 4, 'Чай чёрный', 'Кара чай', 'Black tea', '100 г', 150, 60, {}),
  product(30, 4, 'Кофе растворимый', 'Эрүүчү кофе', 'Instant coffee', '95 г', 280, 45, {}),
  product(31, 4, 'Газированный напиток Cola', 'Cola газдалган суусундук', 'Cola', '1 л', 70, 100, {
    calories: 42,
    carbohydrates: 10.6,
  }),

  product(32, 5, 'Шоколад молочный', 'Сүттүү шоколад', 'Milk chocolate', '100 г', 90, 70, {
    calories: 534,
    protein: 7.6,
    fat: 29.7,
    carbohydrates: 59.4,
  }),
  product(33, 5, 'Печенье овсяное', 'Сулу печеньеси', 'Oatmeal cookies', '300 г', 110, 65, {
    calories: 437,
    protein: 7,
    fat: 17,
    carbohydrates: 65,
  }),
  product(34, 5, 'Чипсы картофельные', 'Картошка чипси', 'Potato chips', '150 г', 95, 55, {
    calories: 536,
    protein: 6.6,
    fat: 35,
    carbohydrates: 53,
  }),
  product(35, 5, 'Мёд натуральный', 'Таза бал', 'Natural honey', '500 г', 350, 4, {
    calories: 304,
    carbohydrates: 82.4,
  }),
  product(36, 5, 'Орехи грецкие', 'Жаңгак', 'Walnuts', '300 г', 400, 3, {
    calories: 654,
    protein: 15.2,
    fat: 65.2,
    carbohydrates: 13.7,
  }),

  product(37, 6, 'Стиральный порошок', 'Жуугуч порошок', 'Laundry detergent', '3 кг', 450, 30, {}),
  product(38, 6, 'Средство для мытья посуды', 'Идиш жуугуч каражат', 'Dishwashing liquid', '500 мл', 95, 50, {}),
  product(39, 6, 'Туалетная бумага, 8 рулонов', 'Даараткана кагазы', 'Toilet paper, 8 rolls', '8 шт.', 180, 60, {}),
  product(40, 6, 'Мыло хозяйственное', 'Чарба самын', 'Laundry soap', '200 г', 35, 80, {}),
];

export async function seedCatalog(db: Database) {
  await db.transaction(async tx => {
    assert(
      await one(tx, 'SELECT 1 FROM stores WHERE id=$1', [seedIds.store]),
      500,
      'SEED_ORDER',
      'Сначала выполните npm run seed',
    );
    for (const c of categories)
      await tx.query('INSERT INTO categories(id,name,sort) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        c.id,
        JSON.stringify(c.name),
        c.sort,
      ]);
    for (const p of products) {
      await tx.query(
        'INSERT INTO products(id,category_id,name,unit,nutrition) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [p.id, p.categoryId, JSON.stringify(p.name), p.unit, JSON.stringify(p.nutrition)],
      );
      await tx.query(
        'INSERT INTO store_products(store_id,product_id,price,stock) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [seedIds.store, p.id, p.price, p.stock],
      );
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.env.NODE_ENV !== 'production', 500, 'DEMO_SEED', 'Демо-данные не предназначены для production');
  assert(process.env.DATABASE_URL, 500, 'CONFIG', 'Задайте DATABASE_URL');
  const db = postgres(process.env.DATABASE_URL);
  try {
    await seedCatalog(db);
    console.log(`Каталог дополнен: ${categories.length} категорий, ${products.length} товаров.`);
  } finally {
    await db.close();
  }
}

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgres,type Database } from '../db.js';
import { assert } from '../core.js';
export const seedIds={store:'10000000-0000-4000-8000-000000000001',category:'20000000-0000-4000-8000-000000000001',lemon:'30000000-0000-4000-8000-000000000001',yogurt:'30000000-0000-4000-8000-000000000002',bread:'30000000-0000-4000-8000-000000000003'};
export async function seed(db:Database) {
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO stores(id,name,address,latitude,longitude,radius_km,delivery_fee,minimum_order,opens_at,closes_at) VALUES($1,'Бекбекей · Чуйкова','улица Чуйкова, 132',42.8746,74.5698,8,10000,0,'09:00','01:00') ON CONFLICT DO NOTHING`,[seedIds.store]);
    await tx.query('INSERT INTO categories(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[seedIds.category,JSON.stringify({ru:'Продукты',ky:'Азык-түлүк',en:'Groceries'})]);
    for(const p of [{id:seedIds.lemon,name:{ru:'Лимоны',ky:'Лимон',en:'Lemons'},price:13000,unit:'2 шт.',nutrition:{calories:34,protein:0.9,fat:0.1,carbohydrates:3}},{id:seedIds.yogurt,name:{ru:'Био йогурт Активиа',ky:'Активиа йогурту',en:'Activia yogurt'},price:16700,unit:'290 г',nutrition:{}},{id:seedIds.bread,name:{ru:'Свежая выпечка',ky:'Жаңы бышырылган нан',en:'Fresh bread'},price:8000,unit:'1 шт.',nutrition:{}}]) {
      await tx.query('INSERT INTO products(id,category_id,name,unit,nutrition,is_new) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING',[p.id,seedIds.category,JSON.stringify(p.name),p.unit,JSON.stringify(p.nutrition)]);
      await tx.query('INSERT INTO store_products(store_id,product_id,price,stock) VALUES($1,$2,$3,100) ON CONFLICT DO NOTHING',[seedIds.store,p.id,p.price]);
    }
    await tx.query("INSERT INTO content(id,kind,title,body) VALUES('40000000-0000-4000-8000-000000000001','NOTICE',$1,$2) ON CONFLICT DO NOTHING",[JSON.stringify({ru:'Первая доставка бесплатно'}),JSON.stringify({ru:'Демо-правило: первая активная покупка получает бесплатную доставку.'})]);
    await tx.query("INSERT INTO promotions(code,kind,value,starts_at,ends_at,usage_limit) VALUES('WELCOME10','PERCENT',10,now()-interval '1 day',now()+interval '1 year',10000) ON CONFLICT DO NOTHING");
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert(process.env.NODE_ENV!=='production',500,'DEMO_SEED','Демо-данные не предназначены для production');assert(process.env.DATABASE_URL,500,'CONFIG','Задайте DATABASE_URL');const db=postgres(process.env.DATABASE_URL);
  try{await seed(db);console.log('Демо-каталог готов. Магазин:',seedIds.store);}finally{await db.close();}
}

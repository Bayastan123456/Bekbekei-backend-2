import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { postgres,one } from '../db.js';
import { assert,passwordHash,phone } from '../core.js';
import { z } from 'zod';
assert(process.env.DATABASE_URL,500,'CONFIG','Задайте DATABASE_URL');
const adminPhone=phone.parse(process.env.ADMIN_PHONE),password=z.string().min(12).max(128).parse(process.env.ADMIN_PASSWORD);
assert(!password.startsWith('change-this'),500,'CONFIG','Задайте свой ADMIN_PASSWORD');
const db=postgres(process.env.DATABASE_URL);
try{
  await db.transaction(async tx=>{
    await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
    assert(!await one(tx,"SELECT 1 FROM users WHERE role='ADMIN'"),409,'ADMIN_EXISTS','Администратор уже создан. Новых сотрудников создавайте через админку');
    assert(!await one(tx,'SELECT 1 FROM users WHERE phone=$1',[adminPhone]),409,'PHONE_EXISTS','Телефон уже используется');
    const id=randomUUID();await tx.query("INSERT INTO users(id,phone,role,password_hash,first_name) VALUES($1,$2,'ADMIN',$3,'Администратор')",[id,adminPhone,passwordHash(password)]);
    const stores=(await tx.query('SELECT id FROM stores')).rows;for(const s of stores)await tx.query('INSERT INTO staff_stores(user_id,store_id) VALUES($1,$2)',[id,s.id]);
    await tx.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[id,'BOOTSTRAP_ADMIN',id]);
  });console.log('Администратор создан');
}finally{await db.close();}

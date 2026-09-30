const request = require('supertest');
const app = require('../src/service');
const { DB, Role } = require('../src/database/database.js');

const testUser = { name: 'pizza diner', email: `${Math.random().toString(36).substring(2, 12)}@test.com`, password: 'admin' };

const adminUser = {
  name: 'pizza admin',
  email: `${Math.random().toString(36).substring(2, 12)}@admin.com`,
  password: 'admin',
};

let testUserAuthToken;
let adminAuthToken;
let franchiseId;
let storeId;

const tokenPattern = /^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/;

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}


beforeAll(async () => {
  const registerRes = await request(app).post('/api/auth').send(testUser);
  expect(registerRes.status).toBe(200);
  testUserAuthToken = registerRes.body.token;

  await DB.addUser({
    ...adminUser,
    roles: [{ role: Role.Admin }],
  });

  const adminLoginRes = await request(app).put('/api/auth').send(adminUser);
  expect(adminLoginRes.status).toBe(200);
  adminAuthToken = adminLoginRes.body.token;
});

test('register', async () => {
  const user = {
    name: 'another diner',
    email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
    password: 'password',
  };

  const res = await request(app).post('/api/auth').send(user);

  expect(res.status).toBe(200);
  expect(res.body.token).toMatch(tokenPattern);
  expect(res.body.user).toMatchObject({
    name: user.name,
    email: user.email,
    roles: [{ role: 'diner' }],
  });
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(tokenPattern);
  expect(loginRes.body.user).toMatchObject({
    name: testUser.name,
    email: testUser.email,
    roles: [{ role: 'diner' }],
  });

  testUserAuthToken = loginRes.body.token;
});

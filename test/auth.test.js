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

test('get current user', async () => {
  const res = await request(app)
    .get('/api/user/me')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    name: testUser.name,
    email: testUser.email,
    roles: [{ role: 'diner' }],
  });
});

test('get menu', async () => {
  const res = await request(app).get('/api/order/menu');

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('add menu item', async () => {
  const menuItem = {
    title: `Test pizza ${Date.now()}`,
    description: 'Test pizza',
    image: 'pizza9.png',
    price: 0.01,
  };

  const res = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send(menuItem);

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body).toEqual(
    expect.arrayContaining([expect.objectContaining(menuItem)]),
  );
});

test('get orders', async () => {
  const res = await request(app)
    .get('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('orders');
  expect(res.body).toHaveProperty('page');
});

test('get orders', async () => {
  const res = await request(app)
    .get('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('orders');
  expect(res.body).toHaveProperty('page');
});

test('create order', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      reportUrl: 'http://factory.test/report',
      jwt: 'factory-token',
    }),
  });

  const order = {
    franchiseId: 1,
    storeId: 1,
    items: [
      {
        menuId: 1,
        description: 'Veggie',
        price: 0.05,
      },
    ],
  };

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(order);

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('order');
  expect(res.body).toHaveProperty('jwt', 'factory-token');

  fetchMock.mockRestore();
});

test('list franchises', async () => {
  const res = await request(app).get('/api/franchise');

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('franchises');
  expect(res.body).toHaveProperty('more');
});

test('create franchise', async () => {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({
      name: `Test franchise ${Date.now()}`,
      admins: [{ email: adminUser.email }],
    });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('id');

  franchiseId = res.body.id;
});

test('get user franchises', async () => {
  const user = await DB.getUser(testUser.email, testUser.password);

  const res = await request(app)
    .get(`/api/franchise/${user.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('create franchise store', async () => {
  const res = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({
      name: `Test store ${Date.now()}`,
    });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('id');

  storeId = res.body.id;
});

test('delete franchise store', async () => {
  const res = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'store deleted' });
});

test('delete franchise', async () => {
  const res = await request(app)
    .delete(`/api/franchise/${franchiseId}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'franchise deleted' });
});

test('logout', async () => {
  const res = await request(app)
    .delete('/api/auth')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'logout successful' });
});
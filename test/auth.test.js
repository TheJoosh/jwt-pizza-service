const users = [];
const tokens = new Map();
const menu = [];
const franchises = [];
const orders = [];
let nextId = 1;

const mockRole = {
  Diner: 'diner',
  Franchisee: 'franchisee',
  Admin: 'admin',
};

const mockDB = {
  addUser: jest.fn(async (user) => {
    const savedUser = {
      ...user,
      id: nextId++,
      password: user.password,
    };
    users.push(savedUser);
    return { ...savedUser, password: undefined };
  }),
  getUser: jest.fn(async (email, password) => {
    const user = users.find((candidate) => candidate.email === email && (!password || candidate.password === password));
    if (!user) {
      throw new Error('unknown user');
    }
    return { ...user, password: undefined };
  }),
  getUsers: jest.fn(async () => users.map(({ password, ...user }) => user)),
  deleteUser: jest.fn(async (userId) => {
    const index = users.findIndex((user) => user.id === userId);
    if (index >= 0) {
      users.splice(index, 1);
    }
  }),
  loginUser: jest.fn(async (userId, token) => {
    tokens.set(token, userId);
  }),
  updateUser: jest.fn(async (userId, name, email, password) => {
    const user = users.find((candidate) => candidate.id === userId);
    const updatedUser = {
      ...user,
      name: name || user.name,
      email: email || user.email,
      password: password || user.password,
    };
    return { ...updatedUser, password: undefined };
  }),
  isLoggedIn: jest.fn(async (token) => tokens.has(token)),
  logoutUser: jest.fn(async (token) => {
    tokens.delete(token);
  }),
  getMenu: jest.fn(async () => menu),
  addMenuItem: jest.fn(async (item) => {
    menu.push({ ...item, id: nextId++ });
  }),
  getOrders: jest.fn(async (user, page = 1) => ({
    dinerId: user.id,
    orders: orders.filter((order) => order.dinerId === user.id),
    page: Number(page),
  })),
  addDinerOrder: jest.fn(async (user, order) => {
    const savedOrder = { ...order, id: nextId++, dinerId: user.id };
    orders.push(savedOrder);
    return savedOrder;
  }),
  getFranchises: jest.fn(async () => [franchises, false]),
  createFranchise: jest.fn(async (franchise) => {
    const savedFranchise = { ...franchise, id: nextId++, stores: [], admins: [] };
    franchises.push(savedFranchise);
    return savedFranchise;
  }),
  getUserFranchises: jest.fn(async () => []),
  getFranchise: jest.fn(async (franchise) => franchises.find(({ id }) => id === franchise.id)),
  createStore: jest.fn(async (franchiseId, store) => ({ id: nextId++, franchiseId, name: store.name })),
  deleteStore: jest.fn(async () => {}),
  deleteFranchise: jest.fn(async () => {}),
};

jest.mock('../src/database/database.js', () => ({ DB: mockDB, Role: mockRole }));

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

const { asyncHandler, StatusCodeError } = require('../src/endpointHelper');

test('asyncHandler forwards rejected promises to next', async () => {
  const error = new Error('test failure');
  const next = jest.fn();

  const handler = asyncHandler(async () => {
    throw error;
  });

  handler({}, {}, next);

  await new Promise(setImmediate);

  expect(next).toHaveBeenCalledWith(error);
});

test('StatusCodeError stores the status code', () => {
  const error = new StatusCodeError('forbidden', 403);

  expect(error.message).toBe('forbidden');
  expect(error.statusCode).toBe(403);
});

test('returns service documentation', async () => {
  const res = await request(app).get('/api/docs');

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('version');
  expect(Array.isArray(res.body.endpoints)).toBe(true);
  expect(res.body).toHaveProperty('config');
});

test('returns the welcome response', async () => {
  const res = await request(app).get('/');

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('message', 'welcome to JWT Pizza');
  expect(res.body).toHaveProperty('version');
});

test('returns 404 for an unknown endpoint', async () => {
  const res = await request(app).get('/does-not-exist');

  expect(res.status).toBe(404);
  expect(res.body).toEqual({ message: 'unknown endpoint' });
});

test('returns database errors through the service error handler', async () => {
  DB.getMenu.mockRejectedValueOnce(new Error('menu unavailable'));

  const res = await request(app).get('/api/order/menu');

  expect(res.status).toBe(500);
  expect(res.body).toMatchObject({
    message: 'menu unavailable',
  });
});

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

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
  const [user, userToken] = await registerUser(request(app));
  const listUsersRes = await request(app)
    .get('/api/user')
    .set('Authorization', 'Bearer ' + userToken);
  expect(listUsersRes.status).toBe(200);
  expect(Array.isArray(listUsersRes.body.users)).toBe(true);
  expect(listUsersRes.body.users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: user.id,
        name: user.name,
        email: user.email,
        roles: user.roles,
      }),
    ]),
  );
});

test('delete user', async () => {
  const user = {
    name: 'pizza diner to delete',
    email: `${randomName()}@test.com`,
    password: 'password',
  };
  const registerRes = await request(app).post('/api/auth').send(user);
  expect(registerRes.status).toBe(200);

  const deleteRes = await request(app)
    .delete(`/api/user/${registerRes.body.user.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(deleteRes.status).toBe(204);
  await expect(DB.getUser(user.email, user.password)).rejects.toThrow('unknown user');
});

test('rejects deleting a user with an invalid ID', async () => {
  DB.deleteUser.mockClear();
  const res = await request(app)
    .delete('/api/user/not-a-number')
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'unauthorized' });
  expect(DB.deleteUser).not.toHaveBeenCalled();
});

test('rejects deleting a user without admin role', async () => {
  DB.deleteUser.mockClear();
  const user = await DB.getUser(testUser.email, testUser.password);

  const res = await request(app)
    .delete(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'unauthorized' });
  expect(DB.deleteUser).not.toHaveBeenCalled();
});

test('update current user', async () => {
  DB.updateUser.mockClear();
  const user = await DB.getUser(testUser.email, testUser.password);

  const res = await request(app)
    .put(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({
      name: 'updated diner',
      email: user.email,
    });

  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({
    id: user.id,
    name: 'updated diner',
    email: user.email,
  });
  expect(res.body.token).toMatch(tokenPattern);

  expect(DB.updateUser).toHaveBeenCalledWith(
    user.id,
    'updated diner',
    user.email,
    undefined,
  );
});

test('rejects updating another user', async () => {
  DB.updateUser.mockClear();
  const user = await DB.getUser(testUser.email, testUser.password);
  const admin = await DB.getUser(adminUser.email, adminUser.password);

  const res = await request(app)
    .put(`/api/user/${admin.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: 'unauthorized update' });

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'unauthorized' });
  expect(DB.updateUser).not.toHaveBeenCalled();
});

async function registerUser(service) {
  const testUser = {
    name: 'pizza diner',
    email: `${randomName()}@test.com`,
    password: 'a',
  };
  const registerRes = await service.post('/api/auth').send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

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

test('rejects menu item creation by a diner', async () => {
  DB.addMenuItem.mockClear();

  const res = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({
      title: 'Unauthorized pizza',
      description: 'Should not be added',
      image: 'pizza.png',
      price: 1,
    });

  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ message: 'unable to add menu item' });
  expect(DB.addMenuItem).not.toHaveBeenCalled();
});

test('get orders', async () => {
  const res = await request(app)
    .get('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('orders');
  expect(res.body).toHaveProperty('page');
});

test('returns an error when the factory rejects an order', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    json: async () => ({
      reportUrl: 'http://factory.test/report',
    }),
  });

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({
      franchiseId: 1,
      storeId: 1,
      items: [
        {
          menuId: 1,
          description: 'Veggie',
          price: 0.05,
        },
      ],
    });

  expect(res.status).toBe(500);
  expect(res.body).toEqual({
    message: 'Failed to fulfill order at factory',
    followLinkToEndChaos: 'http://factory.test/report',
  });

  fetchMock.mockRestore();
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

test('does not return another user’s franchises', async () => {
  DB.getUserFranchises.mockClear();
  const user = await DB.getUser(testUser.email, testUser.password);

  const res = await request(app)
    .get(`/api/franchise/${user.id + 100}`)
    .set('Authorization', 'Bearer ' + testUserAuthToken);

  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
  expect(DB.getUserFranchises).not.toHaveBeenCalled();
});

test('rejects store creation by a non-franchise admin', async () => {
  DB.getFranchise.mockResolvedValueOnce({
    id: franchiseId,
    admins: [{ id: 999 }],
  });
  DB.createStore.mockClear();

  const res = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', 'Bearer ' + testUserAuthToken)
    .send({ name: 'Unauthorized store' });

  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ message: 'unable to create a store' });
  expect(DB.createStore).not.toHaveBeenCalled();
});

test('rejects store deletion by a non-franchise admin', async () => {
  DB.getFranchise.mockResolvedValueOnce({
    id: franchiseId,
    admins: [{ id: 999 }],
  });
  DB.deleteStore.mockClear();

  const res = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
    .set('Authorization', 'Bearer ' + testUserAuthToken);

  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ message: 'unable to delete a store' });
  expect(DB.deleteStore).not.toHaveBeenCalled();
});

test('logout', async () => {
  const res = await request(app)
    .delete('/api/auth')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'logout successful' });
});
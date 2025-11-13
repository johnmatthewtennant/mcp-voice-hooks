import { TestServer } from '../test-utils/test-server.js';

describe('UI Routing', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /', () => {
    it('should serve messenger UI (index.html) by default', async () => {
      const response = await fetch(`${server.url}/`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('app.js');
      expect(html).toContain('Voice Mode'); // Title
    });
  });

  describe('GET /legacy', () => {
    it('should always serve legacy.html', async () => {
      const response = await fetch(`${server.url}/legacy`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('legacy.js');
    });
  });

  describe('GET /messenger', () => {
    it('should serve messenger UI (index.html)', async () => {
      const response = await fetch(`${server.url}/messenger`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('app.js');
    });
  });
});

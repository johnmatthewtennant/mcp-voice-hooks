import { TestServer } from '../test-utils/test-server.js';

describe('Speech rate sync', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should accept speechRate alongside selectedVoice', async () => {
    const response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system', speechRate: 300 }),
    });

    const data = await response.json() as any;
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.selectedVoice).toBe('system');
    expect(data.speechRate).toBe(300);
  });

  it('should clamp speechRate to valid range (50-500)', async () => {
    // Too low
    let response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system', speechRate: 10 }),
    });
    let data = await response.json() as any;
    expect(data.speechRate).toBe(50);

    // Too high
    response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system', speechRate: 999 }),
    });
    data = await response.json() as any;
    expect(data.speechRate).toBe(500);
  });

  it('should preserve default rate when speechRate not provided', async () => {
    const response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system' }),
    });

    const data = await response.json() as any;
    expect(data.speechRate).toBe(200); // default
  });

  it('should ignore invalid speechRate types', async () => {
    const response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system', speechRate: 'fast' }),
    });

    const data = await response.json() as any;
    expect(data.speechRate).toBe(200); // unchanged from default
  });

  it('should round speechRate to integer', async () => {
    const response = await fetch(`${server.url}/api/selected-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVoice: 'system', speechRate: 275.7 }),
    });

    const data = await response.json() as any;
    expect(data.speechRate).toBe(276);
  });
});

import { CONFIG, upgradeUrl } from '../src/config';

describe('upgrade link', () => {
  it('uses the live Pro Payment Link with the install id as client_reference_id', () => {
    expect(CONFIG.PAYMENT_LINK).toBe('https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03');
    const id = '3f2b8c1e-1111-4222-8333-123456789abc';
    expect(upgradeUrl(id)).toBe(`https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03?client_reference_id=${id}`);
    expect(upgradeUrl('')).toBe(CONFIG.PAYMENT_LINK);
    expect(upgradeUrl('bad id&x=1')).toBe(CONFIG.PAYMENT_LINK);
  });
});

describe('Stripe only (no WeChat)', () => {
  it('has no WeChat config or copy in the extension sources', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    expect((CONFIG as Record<string, unknown>).WECHAT).toBeUndefined();
    const files = [...readdirSync('src').map((f) => `src/${f}`), 'static/dashboard.html', 'static/dashboard.css',
                   'static/_locales/en/messages.json', 'static/_locales/zh_CN/messages.json', 'store/listing.zh.md', 'store/listing.en.md'];
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      for (const bad of ['微信', '¥29', '¥129', 'wechat', '收款码', '付款截图']) expect(t.toLowerCase(), `${bad} in ${f}`).not.toContain(bad.toLowerCase());
    }
  });
});

describe('release check', () => {
  it('flags QR images, unexpected images and WeChat copy; passes a clean build', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const realQr = join(mkdtempSync(join(tmpdir(), 'qr-')), 'real.jpg');
    writeFileSync(realQr, Buffer.from('fake-real-qr-bytes'));
    process.env.XENG_REAL_QR_PATH = realQr;
    vi.resetModules();
    // @ts-expect-error plain .mjs script
    const { checkRelease } = await import('../scripts/check_release.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'rel-'));
    mkdirSync(join(dir, 'icons'));
    writeFileSync(join(dir, 'icons/icon16.png'), 'png');
    writeFileSync(join(dir, 'dashboard.html'), '<p>Buy Pro $4.99</p>');
    expect(checkRelease(dir)).toEqual([]);
    writeFileSync(join(dir, 'pay.jpg'), Buffer.from('fake-real-qr-bytes'));         // real QR under an innocent name
    writeFileSync(join(dir, 'wechat_pay_qr.jpg'), 'x');
    writeFileSync(join(dir, 'x.js'), 'const t = "或微信支付 ¥29"');
    const bad = checkRelease(dir).join('\n');
    expect(bad).toContain('pay.jpg: is the real payment QR');
    expect(bad).toContain('wechat_pay_qr.jpg: QR/WeChat-like file name');
    expect(bad).toContain('x.js: WeChat/QR payment text');
    delete process.env.XENG_REAL_QR_PATH;
  });
});

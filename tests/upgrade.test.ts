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

describe('manual WeChat option', () => {
  it('is configured with ¥29, a placeholder contact and a local QR file', () => {
    expect(CONFIG.WECHAT).toMatchObject({ ENABLED: true, PRICE_CNY: 29, QR: 'wechat_pay_qr.jpg', CONTACT: 'go_with_prob@mail.grokbot.com' });
  });
});

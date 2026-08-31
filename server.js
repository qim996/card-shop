/**
 * 卡铺 · 支付宝支付网关（可选后端）
 * ------------------------------------------------------------
 * 作用：GitHub Pages 是纯静态环境，无法安全持有支付宝私钥。
 *       本网关负责：创建当面付订单、把收款码转成二维码图片、
 *       轮询/查询订单支付状态。前端（index.html）通过它完成真实收款。
 *
 * 依赖（在项目目录执行）：
 *   npm init -y
 *   npm install express alipay-sdk qrcode
 *
 * 运行：
 *   ALIPAY_APP_ID=xxxx ALIPAY_PRIVATE_KEY="..." ALIPAY_PUBLIC_KEY="..." node server.js
 *   或写入 .env 后使用 dotenv（可选）
 *
 * 环境变量：
 *   PORT               监听端口，默认 3000
 *   ALLOW_ORIGIN       允许跨域的前端地址，默认 *（建议设为你的 GitHub Pages 域名）
 *   ALIPAY_APP_ID      支付宝开放平台应用的 AppID（当面付）
 *   ALIPAY_PRIVATE_KEY 应用私钥（PKCS8，含 -----BEGIN 头尾）
 *   ALIPAY_PUBLIC_KEY  支付宝公钥（在开放平台「密钥管理」获取）
 *
 * 对接协议（与 index.html 一致）：
 *   GET /api/create?orderNo=&amount=&subject=
 *      -> { code:0, qrcode:"data:image/png;base64,...", orderNo }  （qrcode 直接用于 <img> 展示）
 *   GET /api/query?orderNo=
 *      -> { code:0, paid:true|false }
 *   POST /api/notify   支付宝异步回调（可选，用于服务端记账）
 */
const express = require('express');
const AlipaySdk = require('alipay-sdk').default;
const { AlipayTradePrecreate, AlipayTradeQuery } = require('alipay-sdk/lib/api');
const QRCode = require('qrcode');
const app = express();
const PORT = process.env.PORT || 3000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const REQUIRED = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[卡铺网关] 缺少环境变量: ' + missing.join(', '));
  console.error('请设置后重新启动：ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY');
  process.exit(1);
}
const alipaySdk = new AlipaySdk({
  appId: process.env.ALIPAY_APP_ID,
  privateKey: process.env.ALIPAY_PRIVATE_KEY,
  alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY,
  gateway: 'https://openapi.alipay.com/gateway.do',
});
// CORS（允许 GitHub Pages 等前端跨域调用）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// 健康检查
app.get('/', (req, res) => res.json({ ok: true, name: '卡铺支付网关' }));
// 创建当面付订单 -> 返回收款码图片(dataURL)
app.get('/api/create', async (req, res) => {
  const orderNo = String(req.query.orderNo || '').trim();
  const amount = parseFloat(req.query.amount);
  const subject = String(req.query.subject || '卡密商品').slice(0, 128);
  if (!orderNo || !(amount > 0)) return res.json({ code: 1, msg: '参数缺失：orderNo / amount' });
  try {
    const r = await alipaySdk.execute(new AlipayTradePrecreate({
      bizContent: {
        out_trade_no: orderNo,
        total_amount: amount.toFixed(2),
        subject,
        timeout_express: '15m',
      },
    }));
    if (!r.qrCode) return res.json({ code: 1, msg: '支付宝未返回收款码：' + (r.subMsg || '未知错误') });
    const qrcode = await QRCode.toDataURL(r.qrCode);
    res.json({ code: 0, qrcode, orderNo });
  } catch (e) {
    res.json({ code: 1, msg: e.message });
  }
});
// 查询订单支付状态
app.get('/api/query', async (req, res) => {
  const orderNo = String(req.query.orderNo || '').trim();
  if (!orderNo) return res.json({ code: 1, msg: '缺少 orderNo' });
  try {
    const r = await alipaySdk.execute(new AlipayTradeQuery({
      bizContent: { out_trade_no: orderNo },
    }));
    const paid = r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED';
    res.json({ code: 0, paid, tradeStatus: r.tradeStatus || '' });
  } catch (e) {
    res.json({ code: 1, msg: e.message, paid: false });
  }
});
// 支付宝异步回调（可选，用于服务端记录/对账；生产环境请校验签名）
app.post('/api/notify', (req, res) => {
  const p = req.body || {};
  // 注意：正式使用请用 alipaySdk.checkNotifySign(p) 校验签名
  console.log('[notify]', p.out_trade_no, p.trade_status, p.total_amount);
  res.send('success');
});
app.listen(PORT, () => {
  console.log('[卡铺网关] 已启动: http://localhost:' + PORT);
});

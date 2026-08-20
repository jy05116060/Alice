const appId = process.argv[2]
const appSecret = process.argv[3]
try {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const j = await r.json()
  console.log('HTTP', r.status)
  console.log('code:', j.code, '| msg:', j.msg)
  console.log('got tenant_access_token:', !!j.tenant_access_token, '| expire:', j.expire)
} catch (e) {
  console.log('NETWORK ERROR:', e.message)
}

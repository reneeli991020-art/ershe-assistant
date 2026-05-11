const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: 'sdk' });
});

app.listen(PORT, () => {
  console.log(`✅ 二奢话术助手服务已启动`);
  console.log(`   访问地址: http://localhost:${PORT}`);
});

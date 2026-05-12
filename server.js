require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'query_log.jsonl');
const COZE_API_BASE = 'https://api.coze.cn';
const COZE_API_KEY = process.env.COZE_API_KEY;
const COZE_BOT_ID = process.env.COZE_BOT_ID;

if (!COZE_API_KEY || !COZE_BOT_ID) {
  console.error('❌ 请设置 COZE_API_KEY 和 COZE_BOT_ID');
  process.exit(1);
}

function cozeHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${COZE_API_KEY}`
  };
}

function logQuery(entry) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (e) { /* ignore log errors */ }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.post('/api/chat', async (req, res) => {
  const { query, file_ids } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: '请输入对话内容' });
  }

  logQuery({ query: query.trim(), hasImage: !!(file_ids && file_ids.length > 0), status: 'pending' });

  try {
    const messages = [{ role: 'user', content: query.trim(), content_type: 'text' }];
    if (file_ids && Array.isArray(file_ids) && file_ids.length > 0) {
      messages.push({ role: 'user', content: JSON.stringify({ file_id: file_ids[0] }), content_type: 'image' });
    }

    const createRes = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers: cozeHeaders(),
      body: JSON.stringify({
        bot_id: COZE_BOT_ID,
        user_id: 'user-' + Date.now(),
        additional_messages: messages,
        stream: false,
        auto_save_history: true
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return res.status(502).json({ error: `COZE 请求失败 (${createRes.status})` });
    }

    const createData = await createRes.json();
    if (createData.code !== 0) {
      return res.status(502).json({ error: `COZE 错误: ${createData.msg}` });
    }

    const { id: chatId, conversation_id: convId } = createData.data;

    let status = 'in_progress';
    let attempts = 0;
    while (status === 'in_progress' && attempts < 60) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(
        `${COZE_API_BASE}/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${convId}`,
        { headers: cozeHeaders() }
      );
      if (pollRes.ok) {
        const pollData = await pollRes.json();
        status = pollData.data?.status || 'failed';
      }
      attempts++;
    }

    if (status !== 'completed') {
      return res.status(504).json({ error: 'COZE 响应超时，请重试' });
    }

    const msgRes = await fetch(
      `${COZE_API_BASE}/v3/chat/message/list?chat_id=${chatId}&conversation_id=${convId}`,
      { headers: cozeHeaders() }
    );

    if (!msgRes.ok) {
      return res.status(502).json({ error: '获取 COZE 响应失败' });
    }

    const msgData = await msgRes.json();
    const messages = msgData.data || [];
    const answerMsg = messages.find(m => m.type === 'answer');
    const content = answerMsg?.content || '（未获取到回复）';

    const followUps = messages
      .filter(m => m.type === 'follow_up')
      .map(m => m.content);

    res.json({ content, followUps });
  } catch (err) {
    res.status(502).json({ error: '服务器请求 COZE 失败：' + err.message });
  }
});

app.post('/api/upload', async (req, res) => {
  const { file, filename, mime } = req.body;
  if (!file) return res.status(400).json({ error: '缺少文件数据' });

  try {
    const buffer = Buffer.from(file, 'base64');
    const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
    const form = new FormData();
    form.append('file', blob, filename || 'image.' + (mime?.includes('png') ? 'png' : 'jpg'));

    const uploadRes = await fetch(`${COZE_API_BASE}/v1/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${COZE_API_KEY}` },
      body: form
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || uploadData.code !== 0) {
      return res.status(502).json({ error: `COZE 上传失败: ${uploadData.msg || uploadRes.status}` });
    }

    const fileId = uploadData.data?.id;
    if (!fileId) {
      return res.status(502).json({ error: 'COZE 未返回文件 ID' });
    }

    res.json({ file_id: fileId });
  } catch (err) {
    res.status(502).json({ error: '上传失败：' + err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botId: COZE_BOT_ID ? '已配置' : '未配置' });
});

app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const logs = lines.map(l => JSON.parse(l));
    res.json(logs.slice(-200)); // latest 200
  } catch (e) {
    res.status(500).json({ error: '读取日志失败' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 二奢话术助手服务已启动`);
  console.log(`   访问地址: http://localhost:${PORT}`);
});

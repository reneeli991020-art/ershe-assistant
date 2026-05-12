require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.post('/api/chat', async (req, res) => {
  const { query, file_ids } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: '请输入对话内容' });
  }

  try {
    const message = { role: 'user', content: query.trim(), content_type: 'text' };
    if (file_ids && Array.isArray(file_ids) && file_ids.length > 0) {
      message.file_ids = file_ids;
    }

    const createRes = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers: cozeHeaders(),
      body: JSON.stringify({
        bot_id: COZE_BOT_ID,
        user_id: 'user-' + Date.now(),
        additional_messages: [message],
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
    while (status === 'in_progress' && attempts < 30) {
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
  const { file, filename } = req.body;
  if (!file) return res.status(400).json({ error: '缺少文件数据' });

  try {
    const buffer = Buffer.from(file, 'base64');
    const blob = new Blob([buffer]);
    const form = new FormData();
    form.append('file', blob, filename || 'image.jpg');

    const uploadRes = await fetch(`${COZE_API_BASE}/v1/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${COZE_API_KEY}` },
      body: form
    });

    if (!uploadRes.ok) {
      return res.status(502).json({ error: '图片上传失败' });
    }

    const uploadData = await uploadRes.json();
    if (uploadData.code !== 0) {
      return res.status(502).json({ error: `COZE 上传错误: ${uploadData.msg}` });
    }

    res.json({ file_id: uploadData.data.id });
  } catch (err) {
    res.status(502).json({ error: '上传失败：' + err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botId: COZE_BOT_ID ? '已配置' : '未配置' });
});

app.listen(PORT, () => {
  console.log(`✅ 二奢话术助手服务已启动`);
  console.log(`   访问地址: http://localhost:${PORT}`);
});

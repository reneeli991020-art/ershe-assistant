require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const COZE_API_BASE = 'https://api.coze.cn';
const COZE_API_KEY = process.env.COZE_API_KEY;
const COZE_BOT_ID = process.env.COZE_BOT_ID;

if (!COZE_API_KEY || !COZE_BOT_ID) {
  console.error('❌ 请设置 COZE_API_KEY 和 COZE_BOT_ID 环境变量');
  console.error('   可以复制 .env.example 为 .env 并填写配置');
  process.exit(1);
}

function cozeHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${COZE_API_KEY}`
  };
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// COZE 对话代理接口（coze.cn 流程：创建→轮询→取消息）
app.post('/api/chat', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: '请输入对话内容' });
  }

  try {
    // 1. 创建对话
    const createRes = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers: cozeHeaders(),
      body: JSON.stringify({
        bot_id: COZE_BOT_ID,
        user_id: 'user-' + Date.now(),
        additional_messages: [
          { role: 'user', content: query.trim(), content_type: 'text' }
        ],
        stream: false,
        auto_save_history: true
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('COZE create error:', createRes.status, errText);
      return res.status(502).json({ error: `COZE 请求失败 (${createRes.status})` });
    }

    const createData = await createRes.json();
    if (createData.code !== 0) {
      return res.status(502).json({ error: `COZE 错误: ${createData.msg}` });
    }

    const { id: chatId, conversation_id: convId } = createData.data;

    // 2. 轮询等待完成（最多等 60 秒）
    let status = 'in_progress';
    let attempts = 0;
    const maxAttempts = 30;
    while (status === 'in_progress' && attempts < maxAttempts) {
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

    // 3. 获取消息列表
    const msgRes = await fetch(
      `${COZE_API_BASE}/v3/chat/message/list?chat_id=${chatId}&conversation_id=${convId}`,
      { headers: cozeHeaders() }
    );

    if (!msgRes.ok) {
      return res.status(502).json({ error: '获取 COZE 响应失败' });
    }

    const msgData = await msgRes.json();
    const messages = msgData.data || [];

    // 4. 提取 bot 的回答（type === "answer"）
    const answerMsg = messages.find(m => m.type === 'answer');
    const content = answerMsg?.content || '（未获取到回复）';

    // 5. 提取推荐问题
    const followUps = messages
      .filter(m => m.type === 'follow_up')
      .map(m => m.content);

    res.json({ content, followUps });
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: '服务器请求 COZE 失败：' + err.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botId: COZE_BOT_ID ? '已配置' : '未配置' });
});

app.listen(PORT, () => {
  console.log(`✅ 二奢话术助手服务已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   API 代理: http://localhost:${PORT}/api/chat`);
});

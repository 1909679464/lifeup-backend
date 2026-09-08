import express from "express";
import cors from "cors";
import { getActiveBloggers, saveBloggers, searchBloggersFromCoze, verifyAllBloggers } from './services/bloggerService';

const app = express();
const port = process.env.PORT || 9091;

// 定时任务：每天凌晨 2 点验证博主
const startBloggerVerificationJob = () => {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(2, 0, 0, 0);
  
  // 如果今天已经过了 2 点，设置为明天
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  
  const timeUntilNextRun = nextRun.getTime() - now.getTime();
  
  console.log(`博主验证任务将在 ${timeUntilNextRun / 1000 / 60 / 60} 小时后执行`);
  
  setTimeout(() => {
    verifyAllBloggers().catch(console.error);
    
    // 之后每 24 小时执行一次
    setInterval(() => {
      verifyAllBloggers().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }, timeUntilNextRun);
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

// Coze API Configuration
const COZE_API_TOKEN = process.env.COZE_WORKLOAD_API_TOKEN || 'cztei_qimhwNZL9DRtEXF7oPn69lYRA7DS1GwOeAkcFPdP9cZ3S7IheUwpQ1Tsxp9iExu1Q';
const COZE_API_BASE = process.env.COZE_API_BASE_URL || 'https://api.coze.cn';
const BOT_ID = process.env.COZE_BOT_ID || '7680396415612649518';

// 带超时的 fetch，避免请求无限卡死
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 40000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// AI Suggestion API - 使用扣子 Bot
app.post('/api/v1/ai/suggestion', async (req, res) => {
  try {
    const { type } = req.body;
    
    // 输入验证：只允许身材管理和穿搭两个类型
    const allowedTypes = ['body', 'wardrobe'];
    if (!type || !allowedTypes.includes(type)) {
      return res.status(400).json({ error: '无效的建议类型，必须是：body 或 wardrobe' });
    }
    
    const prompts: Record<string, string> = {
      body: '请给出一条关于身材管理的实用建议，可以是运动技巧、饮食建议、体态改善或心态调整。建议要具体、可执行、有激励性。控制在100字以内。',
      wardrobe: '请给出一条关于男士穿搭的实用建议，可以是配色技巧、单品推荐、场合搭配或显瘦技巧。建议要具体、可执行、有激励性。控制在100字以内。',
    };

    const userMessage = prompts[type];

    // 调用扣子 Bot API（带重试机制）
    const headers: Record<string, string> = {
      Authorization: `Bearer ${COZE_API_TOKEN}`,
      "Content-Type": "application/json",
    };

    let chatResult: any;
    let conversationId: string = '';
    let chatId: string = '';
    let success = false;
    
    // 重试机制：最多重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 创建对话
        const chatResponse = await fetchWithTimeout(`${COZE_API_BASE}/v3/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            bot_id: BOT_ID,
            user_id: "lifeup_app_user",
            stream: false,
            additional_messages: [
              {
                role: "user",
                content: userMessage,
                content_type: "text",
              },
            ],
            auto_save_history: true,
          }),
        });

        chatResult = await chatResponse.json();
        
        if (chatResult.code === 0) {
          conversationId = chatResult.data.conversation_id;
          chatId = chatResult.data.id;
          success = true;
          break;
        } else {
          console.error(`Coze API error (attempt ${attempt}):`, chatResult);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch (error) {
        console.error(`Coze API request failed (attempt ${attempt}):`, error);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (!success || !conversationId || !chatId) {
      return res.status(500).json({ error: 'AI 服务调用失败，请稍后重试' });
    }

    // 轮询等待对话完成
    const terminalStatuses = ["completed", "failed", "canceled"];
    let retrieveResult: any;

    for (let i = 0; i < 30; i++) {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        chat_id: chatId,
      });

      const retrieveResponse = await fetchWithTimeout(
        `${COZE_API_BASE}/v3/chat/retrieve?${params}`,
        { headers }
      );

      retrieveResult = await retrieveResponse.json();
      if (terminalStatuses.includes(retrieveResult.data.status)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // 获取对话消息
    const messageParams = new URLSearchParams({
      conversation_id: conversationId,
      chat_id: chatId,
    });

    const messageResponse = await fetchWithTimeout(
      `${COZE_API_BASE}/v3/chat/message/list?${messageParams}`,
      { headers }
    );

    const messageResult: any = await messageResponse.json();
    
    // 提取 AI 回复
    const messages = messageResult.data || [];
    const aiMessage = messages.find((msg: any) => msg.role === 'assistant');
    const suggestion = aiMessage?.content || '暂无建议';

    res.status(200).json({ suggestion });
  } catch (error) {
    console.error('AI suggestion error:', error);
    res.status(500).json({ error: 'Failed to generate suggestion' });
  }
});

// AI Outfit Recommendation API - 穿搭推荐（带缓存）
app.post('/api/v1/ai/outfit-recommendation', async (req, res) => {
  try {
    const { style } = req.body;
    
    // 输入验证：8 种风格
    const allowedStyles = ['商务正装', '休闲通勤', '街头潮流', '运动健身', '简约极简', '日系清新', '韩系时尚', '复古工装'];
    if (!style || !allowedStyles.includes(style)) {
      return res.status(400).json({ error: '无效的风格类型' });
    }
    
    // 1. 尝试从缓存获取有效的博主
    let bloggers = await getActiveBloggers(style);
    let fromCache = true;
    
    // 2. 如果缓存中没有有效的博主，调用扣子 API 搜索
    if (!bloggers) {
      console.log(`缓存中没有有效的${style}风格博主，调用扣子 API 搜索...`);
      fromCache = false;
      
      const bloggersFromCoze = await searchBloggersFromCoze(style);
      
      if (bloggersFromCoze.length < 2) {
        return res.status(500).json({ 
          error: '未找到符合条件的真实博主，请稍后重试',
          recommendations: [] 
        });
      }
      
      // 保存博主到数据库
      const bloggersToSave = bloggersFromCoze.map((b: any) => ({
        style,
        blogger_name: b.name,
        platform: b.platform,
        followers: b.followers || null,
        search_keyword: b.searchKeyword,
        fallback_keywords: b.fallbackKeywords || [],
        reason: b.reason || '',
        verified: b.verified !== false,
        last_verified: new Date().toISOString(),
        verification_info: b.verificationInfo || '通过扣子 API 验证',
        is_active: true,
      }));
      
      await saveBloggers(bloggersToSave);
      
      // 重新查询保存后的博主
      bloggers = await getActiveBloggers(style);
    }
    
    if (!bloggers || bloggers.length < 2) {
      return res.status(500).json({ 
        error: '未找到符合条件的真实博主，请稍后重试',
        recommendations: [] 
      });
    }
    
    // 3. 生成穿搭推荐（使用缓存的博主）
    const prompt = `你是一位专业的男士穿搭顾问。请根据"${style}"风格，给出 2 套今日穿搭推荐。

要求：
1. 每套推荐包含：标题、描述、搭配单品列表（3-5 件）
2. 推荐要符合当前季节和天气
3. 单品要具体到颜色、材质
4. 描述要生动、有画面感
5. 返回 JSON 格式，结构如下：
{
  "recommendations": [
    {
      "title": "穿搭标题",
      "description": "详细描述",
      "items": ["单品1", "单品2", "单品3"]
    }
  ]
}`;

    // 调用扣子 Bot API 生成穿搭方案
    const headers: Record<string, string> = {
      Authorization: `Bearer ${COZE_API_TOKEN}`,
      "Content-Type": "application/json",
    };

    let chatResult: any;
    let conversationId: string = '';
    let chatId: string = '';
    let success = false;
    
    // 重试机制：最多重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const chatResponse = await fetchWithTimeout(`${COZE_API_BASE}/v3/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            bot_id: BOT_ID,
            user_id: "lifeup_app_user",
            stream: false,
            additional_messages: [
              {
                role: "user",
                content: prompt,
                content_type: "text",
              },
            ],
            auto_save_history: true,
          }),
        });

        chatResult = await chatResponse.json();
        
        if (chatResult.code === 0) {
          conversationId = chatResult.data.conversation_id;
          chatId = chatResult.data.id;
          success = true;
          break;
        } else {
          console.error(`Coze API error (attempt ${attempt}):`, chatResult);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch (error) {
        console.error(`Coze API request failed (attempt ${attempt}):`, error);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (!success || !conversationId || !chatId) {
      return res.status(500).json({ error: 'AI 服务调用失败，请稍后重试' });
    }

    // 轮询等待对话完成
    const terminalStatuses = ["completed", "failed", "canceled"];
    let retrieveResult: any;

    for (let i = 0; i < 30; i++) {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        chat_id: chatId,
      });

      const retrieveResponse = await fetchWithTimeout(
        `${COZE_API_BASE}/v3/chat/retrieve?${params}`,
        { headers }
      );

      retrieveResult = await retrieveResponse.json();
      if (terminalStatuses.includes(retrieveResult.data.status)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // 获取对话消息
    const messageParams = new URLSearchParams({
      conversation_id: conversationId,
      chat_id: chatId,
    });

    const messageResponse = await fetchWithTimeout(
      `${COZE_API_BASE}/v3/chat/message/list?${messageParams}`,
      { headers }
    );

    const messageResult: any = await messageResponse.json();
    
    // 提取 AI 回复
    const messages = messageResult.data || [];
    const aiMessage = messages.find((msg: any) => msg.role === 'assistant');
    const aiContent = aiMessage?.content || '';

    // 尝试解析 JSON
    let recommendations = [];
    try {
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        recommendations = parsed.recommendations || [];
        
        // 添加博主信息
        if (recommendations.length >= 2 && bloggers.length >= 2) {
          recommendations[0].blogger = {
            name: bloggers[0].blogger_name,
            platform: bloggers[0].platform,
            followers: bloggers[0].followers,
            searchKeyword: bloggers[0].search_keyword,
            fallbackKeywords: bloggers[0].fallback_keywords,
            reason: bloggers[0].reason,
            verified: bloggers[0].verified,
            lastVerified: bloggers[0].last_verified,
            verificationInfo: bloggers[0].verification_info,
            fromCache,
          };
          
          recommendations[1].blogger = {
            name: bloggers[1].blogger_name,
            platform: bloggers[1].platform,
            followers: bloggers[1].followers,
            searchKeyword: bloggers[1].search_keyword,
            fallbackKeywords: bloggers[1].fallback_keywords,
            reason: bloggers[1].reason,
            verified: bloggers[1].verified,
            lastVerified: bloggers[1].last_verified,
            verificationInfo: bloggers[1].verification_info,
            fromCache,
          };
        }
      }
    } catch (e) {
      console.error('Failed to parse AI response:', e);
    }

    res.status(200).json({ success: true, recommendations, fromCache });
  } catch (error) {
    console.error('AI outfit recommendation error:', error);
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
  
  // 启动博主验证定时任务
  startBloggerVerificationJob();
});

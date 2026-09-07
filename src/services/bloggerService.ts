import { getSupabaseClient } from '../storage/database/supabase-client';
import type { OutfitBlogger, InsertOutfitBlogger, BloggerVerificationLog, InsertBloggerVerificationLog } from '../storage/database/shared/schema';

const COZE_API_TOKEN = process.env.COZE_WORKLOAD_API_TOKEN || 'cztei_qimhwNZL9DRtEXF7oPn69lYRA7DS1GwOeAkcFPdP9cZ3S7IheUwpQ1Tsxp9iExu1Q';
const COZE_API_BASE = process.env.COZE_API_BASE_URL || 'https://api.coze.cn';
const BOT_ID = process.env.COZE_BOT_ID || '7680396415612649518';

// 获取有效的博主（缓存优先）
export async function getActiveBloggers(style: string): Promise<OutfitBlogger[] | null> {
  const client = getSupabaseClient();
  
  // 查询该风格的已验证且有效的博主（最后验证时间在7天内）
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const { data, error } = await client
    .from('outfit_bloggers')
    .select('*')
    .eq('style', style)
    .eq('is_active', true)
    .eq('verified', true)
    .gte('last_verified', sevenDaysAgo.toISOString())
    .order('last_verified', { ascending: false })
    .limit(2);
  
  if (error) {
    console.error('查询博主失败:', error);
    throw new Error(`查询博主失败: ${error.message}`);
  }
  
  // 如果找到有效的博主，返回
  if (data && data.length >= 2) {
    return data as OutfitBlogger[];
  }
  
  // 否则返回 null，表示需要调用扣子 API 搜索新博主
  return null;
}

// 保存博主到数据库
export async function saveBlogger(blogger: InsertOutfitBlogger): Promise<OutfitBlogger> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from('outfit_bloggers')
    .insert(blogger)
    .select()
    .single();
  
  if (error) {
    console.error('保存博主失败:', error);
    throw new Error(`保存博主失败: ${error.message}`);
  }
  
  return data as OutfitBlogger;
}

// 批量保存博主
export async function saveBloggers(bloggers: InsertOutfitBlogger[]): Promise<void> {
  const client = getSupabaseClient();
  
  const { error } = await client
    .from('outfit_bloggers')
    .insert(bloggers);
  
  if (error) {
    console.error('批量保存博主失败:', error);
    throw new Error(`批量保存博主失败: ${error.message}`);
  }
}

// 更新博主验证状态
export async function updateBloggerVerification(
  bloggerId: number,
  isValid: boolean,
  verificationInfo: string
): Promise<void> {
  const client = getSupabaseClient();
  
  // 更新博主信息
  const { error: updateError } = await client
    .from('outfit_bloggers')
    .update({
      verified: isValid,
      is_active: isValid,
      last_verified: new Date(),
      verification_info: verificationInfo,
      updated_at: new Date(),
    })
    .eq('id', bloggerId);
  
  if (updateError) {
    console.error('更新博主验证状态失败:', updateError);
    throw new Error(`更新博主验证状态失败: ${updateError.message}`);
  }
  
  // 记录验证日志
  const log: InsertBloggerVerificationLog = {
    blogger_id: bloggerId,
    verification_result: isValid,
    verification_details: verificationInfo,
  };
  
  const { error: logError } = await client
    .from('blogger_verification_logs')
    .insert(log);
  
  if (logError) {
    console.error('记录验证日志失败:', logError);
    throw new Error(`记录验证日志失败: ${logError.message}`);
  }
}

// 获取需要验证的博主（最后验证时间超过7天）
export async function getBloggersToVerify(): Promise<OutfitBlogger[]> {
  const client = getSupabaseClient();
  
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const { data, error } = await client
    .from('outfit_bloggers')
    .select('*')
    .eq('is_active', true)
    .or(`last_verified.is.null,last_verified.lt.${sevenDaysAgo.toISOString()}`)
    .order('last_verified', { ascending: true })
    .limit(20);
  
  if (error) {
    console.error('查询待验证博主失败:', error);
    throw new Error(`查询待验证博主失败: ${error.message}`);
  }
  
  return (data || []) as OutfitBlogger[];
}

// 调用扣子 API 搜索博主
export async function searchBloggersFromCoze(style: string): Promise<any> {
  const prompt = `你是一位专业的男士穿搭顾问。请根据"${style}"风格，使用联网搜索功能搜索 2 个真实的穿搭博主。

要求：
1. 使用联网搜索功能搜索真实的博主
2. 验证博主真实性（搜索验证、主页验证、内容验证）
3. 返回 JSON 格式，结构如下：
{
  "bloggers": [
    {
      "name": "博主名称",
      "platform": "平台（小红书 或 抖音）",
      "followers": "粉丝数（如：10万+）",
      "searchKeyword": "主要搜索关键词",
      "fallbackKeywords": ["备选关键词1", "备选关键词2"],
      "reason": "推荐理由",
      "verified": true,
      "verificationInfo": "验证信息"
    }
  ]
}

注意：
- 博主必须是真实存在的
- 必须经过验证
- 提供备选关键词
- 返回纯 JSON，不要添加任何文字`;

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
      const chatResponse = await fetch(`${COZE_API_BASE}/v3/chat`, {
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
    throw new Error('AI 服务调用失败，请稍后重试');
  }

  // 轮询等待对话完成
  const terminalStatuses = ["completed", "failed", "canceled"];
  let retrieveResult: any;

  for (let i = 0; i < 30; i++) {
    const params = new URLSearchParams({
      conversation_id: conversationId,
      chat_id: chatId,
    });

    const retrieveResponse = await fetch(
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

  const messageResponse = await fetch(
    `${COZE_API_BASE}/v3/chat/message/list?${messageParams}`,
    { headers }
  );

  const messageResult: any = await messageResponse.json();
  
  // 提取 AI 回复
  const messages = messageResult.data || [];
  const aiMessage = messages.find((msg: any) => msg.role === 'assistant');
  const aiContent = aiMessage?.content || '';

  // 尝试解析 JSON
  try {
    const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.bloggers || [];
    }
  } catch (e) {
    console.error('Failed to parse AI response:', e);
  }

  return [];
}

/**
 * 验证博主是否仍然有效
 * @param bloggerId 博主 ID
 */
export async function verifyBlogger(bloggerId: number): Promise<{ isValid: boolean; info: string }> {
  // 从数据库获取博主信息
  const client = getSupabaseClient();
  const { data: blogger, error } = await client
    .from('outfit_bloggers')
    .select('*')
    .eq('id', bloggerId)
    .single();

  if (error || !blogger) {
    return { isValid: false, info: '博主不存在' };
  }

  // 调用扣子 API 验证
  const prompt = `请帮我验证以下博主是否仍然有效：
博主名称：${blogger.blogger_name}
平台：${blogger.platform}
搜索关键词：${blogger.search_keyword}

请检查：
1. 博主是否仍然存在
2. 是否改名
3. 账号是否被注销
4. 内容是否仍然相关

返回 JSON 格式：
{
  "isValid": true/false,
  "info": "验证结果说明",
  "newName": "如果改名，新名称",
  "newSearchKeyword": "如果搜索关键词失效，新关键词"
}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${COZE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    const chatResponse = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bot_id: BOT_ID,
        user_id: 'lifeup_app_user',
        stream: false,
        additional_messages: [
          {
            role: 'user',
            content: prompt,
            content_type: 'text',
          },
        ],
        auto_save_history: true,
      }),
    });

    const chatResult: any = await chatResponse.json();
    
    if (chatResult.code !== 0) {
      return { isValid: false, info: `验证失败：${chatResult.msg}` };
    }

    const conversationId = chatResult.data.conversation_id;
    const chatId = chatResult.data.id;

    // 轮询等待完成
    const terminalStatuses = ['completed', 'failed', 'canceled'];
    let retrieveResult: any;

    for (let i = 0; i < 30; i++) {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        chat_id: chatId,
      });

      const retrieveResponse = await fetch(
        `${COZE_API_BASE}/v3/chat/retrieve?${params}`,
        { headers }
      );

      retrieveResult = await retrieveResponse.json();
      if (terminalStatuses.includes(retrieveResult.data.status)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // 获取消息
    const messageParams = new URLSearchParams({
      conversation_id: conversationId,
      chat_id: chatId,
    });

    const messageResponse = await fetch(
      `${COZE_API_BASE}/v3/chat/message/list?${messageParams}`,
      { headers }
    );

    const messageResult: any = await messageResponse.json();
    const messages = messageResult.data || [];
    const aiMessage = messages.find((msg: any) => msg.role === 'assistant');
    const aiContent = aiMessage?.content || '';

    // 解析 JSON
    try {
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // 如果改名，更新名称
        if (parsed.newName && parsed.newName !== blogger.blogger_name) {
          await client
            .from('outfit_bloggers')
            .update({ blogger_name: parsed.newName })
            .eq('id', bloggerId);
        }
        
        // 如果搜索关键词失效，更新关键词
        if (parsed.newSearchKeyword && parsed.newSearchKeyword !== blogger.search_keyword) {
          await client
            .from('outfit_bloggers')
            .update({ search_keyword: parsed.newSearchKeyword })
            .eq('id', bloggerId);
        }
        
        return { 
          isValid: parsed.isValid, 
          info: parsed.info || '验证完成' 
        };
      }
    } catch (e) {
      console.error('Failed to parse verification response:', e);
    }

    return { isValid: false, info: '验证响应解析失败' };
  } catch (error) {
    console.error('Verification error:', error);
    return { isValid: false, info: '验证过程出错' };
  }
}

/**
 * 批量验证所有需要验证的博主
 */
export async function verifyAllBloggers(): Promise<void> {
  const bloggersToVerify = await getBloggersToVerify();
  
  console.log(`开始验证 ${bloggersToVerify.length} 个博主...`);
  
  for (const blogger of bloggersToVerify) {
    try {
      const result = await verifyBlogger(blogger.id);
      await updateBloggerVerification(blogger.id, result.isValid, result.info);
      
      if (!result.isValid) {
        console.log(`博主 ${blogger.blogger_name} 验证失败，已标记为无效`);
        
        // 尝试搜索新的博主替换
        const newBloggers = await searchBloggersFromCoze(blogger.style);
        if (newBloggers.length > 0) {
          const newBlogger = newBloggers[0];
          await saveBlogger({
            style: blogger.style,
            blogger_name: newBlogger.name,
            platform: newBlogger.platform,
            followers: newBlogger.followers || null,
            search_keyword: newBlogger.searchKeyword,
            fallback_keywords: newBlogger.fallbackKeywords || [],
            reason: newBlogger.reason || '',
            verified: newBlogger.verified !== false,
            last_verified: new Date(),
            verification_info: newBlogger.verificationInfo || '通过扣子 API 验证',
            is_active: true,
          });
          console.log(`已添加新博主 ${newBlogger.name} 替换 ${blogger.blogger_name}`);
        }
      } else {
        console.log(`博主 ${blogger.blogger_name} 验证通过`);
      }
    } catch (error) {
      console.error(`验证博主 ${blogger.blogger_name} 失败:`, error);
    }
  }
  
  console.log('博主验证完成');
}

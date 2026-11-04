const WHATSAPP_API_URL = "https://api.whatsapp.com/agent/v1";

exports.handler = async (event) => {
  const WA_TOKEN = process.env.WHATSAPP_TOKEN;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!WA_TOKEN || !GEMINI_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server par WHATSAPP_TOKEN ya GEMINI_API_KEY set nahi hai." })
    };
  }

  const headers = {
    "Authorization": `Bearer ${WA_TOKEN}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Poll WhatsApp Updates (GET /agent/v1/updates)
    const offsetParam = event.queryStringParameters?.offset;
    let pollUrl = `${WHATSAPP_API_URL}/updates?timeout=8`;
    if (offsetParam !== undefined && offsetParam !== "") {
      pollUrl += `&offset=${offsetParam}`;
    }

    const pollRes = await fetch(pollUrl, {
      method: "GET",
      headers: { "Authorization": `Bearer ${WA_TOKEN}` }
    });

    // HTTP 204 ka matlab hai timeout ho gaya aur koi naya message nahi aaya
    if (pollRes.status === 204) {
      return {
        statusCode: 200,
        body: JSON.stringify({ status: "empty", next_offset: offsetParam || null, processed: [] })
      };
    }

    if (!pollRes.ok) {
      const errText = await pollRes.text();
      return { statusCode: pollRes.status, body: errText };
    }

    const data = await pollRes.json();
    const nextOffset = data.next_offset;
    const changes = data.entry?.[0]?.changes?.[0]?.value || {};
    const messages = changes.messages || [];
    const contacts = changes.contacts || [];

    const processedPresentations = [];

    // 2. Har incoming text message ko process karein
    for (const msg of messages) {
      if (msg.type === "text" && msg.text?.body) {
        const sender = msg.from; // Format: user:<id>
        const wamid = msg.id;
        const userTopic = msg.text.body;
        const contactName = contacts.find(c => c.wa_id === sender)?.profile?.name || "WhatsApp User";

        // Step A: Message ko Read mark karein aur Typing Indicator on karein (POST /agent/v1/statuses)
        await fetch(`${WHATSAPP_API_URL}/statuses`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: wamid,
            typing_indicator: { type: "text" }
          })
        });

        // Step B: Gemini AI se Presentation Slides generate karwayein
        const systemPrompt = `You are an expert Presentation Designer. The user sent this presentation topic/request via WhatsApp: "${userTopic}".
Create a structured, high-impact presentation outline. If the user asks in Urdu or Roman Urdu, or requests Urdu slides, generate the content in clear Urdu/Roman Urdu accordingly.
Respond ONLY with valid JSON (no markdown backticks) in this exact format:
{
  "title": "Main Presentation Title",
  "language": "Urdu / English",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Slide Title",
      "bullets": ["Key point 1", "Key point 2", "Key point 3"],
      "speakerNotes": "Brief talking point for the presenter"
    }
  ],
  "whatsappSummary": "A clean, formatted text summary using WhatsApp bold (*text*) and bullet points to reply back on WhatsApp (max 3500 chars)."
}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: systemPrompt }] }],
              generationConfig: { responseMimeType: "application/json" }
            })
          }
        );

        const geminiData = await geminiRes.json();
        const rawAiText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        
        let parsedPlan;
        try {
          parsedPlan = JSON.parse(rawAiText);
        } catch (e) {
          parsedPlan = {
            title: userTopic,
            language: "Auto",
            slides: [{ slideNumber: 1, title: userTopic, bullets: [rawAiText], speakerNotes: "" }],
            whatsappSummary: rawAiText
          };
        }

        // Text message limit 4096 chars hoti hai
        const replyBody = (parsedPlan.whatsappSummary || "Aapki presentation tayar hai! Dashboard par slides dekh lein.").slice(0, 4000);

        // Step C: WhatsApp par wapis reply bhejein (POST /agent/v1/messages)
        await fetch(`${WHATSAPP_API_URL}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: sender,
            type: "text",
            context: { message_id: wamid },
            text: { body: replyBody }
          })
        });

        processedPresentations.push({
          id: wamid,
          sender,
          contactName,
          prompt: userTopic,
          timestamp: msg.timestamp,
          plan: parsedPlan
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "ok",
        next_offset: nextOffset,
        processed: processedPresentations
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

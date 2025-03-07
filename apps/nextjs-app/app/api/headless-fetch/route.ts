import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import cfCheck from "@/utils/cfCheck";
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

const chromium = require("@sparticuz/chromium-min");
const puppeteer = require("puppeteer-core");

interface Message {
  role: string;
  content: string;
}

interface ChatGPTMessage {
  id?: string;
  message: {
    author: {
      role: string;
    };
    content: {
      content_type: string;
      parts: (string | {
        type: string;
        asset_pointer: string;
        size?: {
          width: number;
          height: number;
        };
      })[];
    };
  };
  parent?: string;
  children?: string[];
}

function buildMessageChain(mapping: { [key: string]: ChatGPTMessage }): Message[] {
  const messages: Message[] = [];
  let currentId = Object.keys(mapping)[0];
  
  while (currentId && mapping[currentId]) {
    const currentMessage = mapping[currentId];
    
    if (currentMessage.message?.content?.parts?.length > 0) {
      const parts = currentMessage.message.content.parts;
      const role = currentMessage.message.author.role;
      
      // Convert each part to string safely
      const content = parts.map(part => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part === 'object' && part !== null) {
          if (part.type === 'image') {
            return `[Image${part.size ? ` (${part.size.width}x${part.size.height})` : ''}]`;
          }
          return JSON.stringify(part);
        }
        return '';
      }).join('\n');

      messages.push({ role, content });
    }
    
    // Move to the next message in the chain
    const nextId = mapping[currentId].children?.[0] || "";
    currentId = nextId;
  }
  
  return messages;
}

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Configure for Node.js runtime with increased timeout
export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const urlStr = url.searchParams.get("url");
  const selector = url.searchParams.get("selector") || "pre"; // Default to pre tag if no selector provided
  
  if (!urlStr) {
    return NextResponse.json(
      { error: "Missing url parameter" },
      { status: 400 }
    );
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "-disable-site-isolation-trials",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: isDev ? "" : "headless",
      debuggingPort: isDev ? 9222 : undefined,
    });

    const pages = await browser.pages();
    const page = pages[0];
    await page.setUserAgent(userAgent);
    const preloadFile = fs.readFileSync(
      path.join(process.cwd(), "/utils/preload.js"),
      "utf8"
    );
    await page.evaluateOnNewDocument(preloadFile);
    
    // Navigate to the page and wait for network to be idle
    await page.goto(urlStr, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await cfCheck(page);

    // Wait for the selector to be present
    await page.waitForSelector(selector, { timeout: 10000 });
    
    // Extract JSON content
    const jsonContent = await page.evaluate((selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      try {
        // Try to parse the content as JSON
        return JSON.parse(element.textContent || '');
      } catch (e) {
        console.error('Failed to parse JSON:', e);
        return element.textContent;
      }
    }, selector);

    if (!jsonContent) {
      return NextResponse.json(
        { error: "No JSON content found" },
        { status: 404 }
      );
    }

    return NextResponse.json(jsonContent);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Internal Server Error", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  } finally {
    if (browser) {
      await browser?.close();
    }
  }
}

export async function POST(request: Request) {

    console.log('Received POST request');
    console.log('isDev:', isDev);
    console.log('localExecutablePath:', localExecutablePath);
    console.log('remoteExecutablePath:', remoteExecutablePath);
  try {
    let { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: "ChatGPT share link is required" },
        { status: 400 }
      );
    }

    // Extract conversation ID from the URL
    const match = url.match(/\/share\/([\w-]+)/);
    if (!match) {
      return NextResponse.json(
        { error: "Invalid ChatGPT share link format" },
        { status: 400 }
      );
    }

    const conversationId = match[1];
    console.log('Converting conversation:', conversationId);

    // Convert to backend API URL
    url = `https://chatgpt.com/backend-api/share/${conversationId}`;

    let browser = null;
    try {
      browser = await puppeteer.launch({
        ignoreDefaultArgs: ["--enable-automation"],
        args: isDev
          ? [
              "--disable-blink-features=AutomationControlled",
              "--disable-features=site-per-process",
              "-disable-site-isolation-trials",
            ]
          : [...chromium.args, "--disable-blink-features=AutomationControlled"],
        defaultViewport: { width: 1920, height: 1080 },
        executablePath: isDev
          ? localExecutablePath
          : await chromium.executablePath(remoteExecutablePath),
        headless: isDev ? false : "new",
        debuggingPort: isDev ? 9222 : undefined,
        timeout: 60000, // Set global timeout to 60 seconds
      });

      console.log('Puppeteer browser opened');
      const pages = await browser.pages();
      console.log('Puppeteer pages:', pages);
      const page = pages[0];
      console.log('Puppeteer page opened');
      await page.setUserAgent(userAgent);
      await page.setDefaultTimeout(60000); // Set page-level timeout to 60 seconds
      await page.setDefaultNavigationTimeout(60000); // Set navigation timeout to 60 seconds
      const preloadFile = fs.readFileSync(
        path.join(process.cwd(), "/utils/preload.js"),
        "utf8"
      );
      await page.evaluateOnNewDocument(preloadFile);

      console.log('Navigating to URL:', url);
      
      let response = null;
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          // First wait for network to be idle
          await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {
            console.log('Network not completely idle, proceeding anyway');
          });

          response = await page.goto(url, {
            waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
            timeout: 30000,
          });

          // Check if we got a valid response
          if (response && response.ok()) {
            console.log('Navigation successful');
            break;
          } else {
            throw new Error('Invalid response');
          }
        } catch (error) {
          console.error(`Navigation attempt ${retryCount + 1} failed:`, error);
          retryCount++;
          
          if (retryCount === maxRetries) {
            throw new Error('Failed to navigate after maximum retries');
          }
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Clear cache and cookies before retrying
          await page.setCacheEnabled(false);
          const client = await page.target().createCDPSession();
          await client.send('Network.clearBrowserCookies');
          await client.send('Network.clearBrowserCache');
          
          console.log('Retrying navigation...');
        }
      }

      await cfCheck(page);
      console.log('Navigation complete');
      
      const responseText = await response?.text();
    //   console.log('Raw response:', responseText);

      const jsonContent = JSON.parse(responseText || '{}');
    //   console.log('Parsed JSON:', jsonContent);

      // Extract data from the nested structure
      const data = jsonContent.data || jsonContent;
      
      if (!data?.mapping) {
        console.error('Invalid data structure:', data);
        return NextResponse.json(
          { error: "Invalid conversation data: missing mapping" },
          { status: 500 }
        );
      }

      const messages = buildMessageChain(data.mapping);
    //   console.log('Built message chain:', messages);

      // Convert to markdown format
      const lines: string[] = [];
      lines.push(`# ${data.title || 'Untitled Conversation'}\n`);
      
      for (const message of messages) {
        const role = message.role === 'assistant' ? 'ChatGPT' : 'User';
        lines.push(`## ${role}\n`);
        lines.push(message.content);
        lines.push(''); // Empty line for spacing
      }
      
      const markdown = lines.join('\n');
      console.log('Generated markdown length:', markdown.length);

      return NextResponse.json({ markdown });
    } catch (conversionError) {
      console.error('Conversion error:', conversionError);
      const errorMessage = conversionError instanceof Error 
        ? conversionError.message 
        : 'Unknown error occurred';

      // Check for specific error cases
      if (errorMessage.includes('no longer accessible')) {
        return NextResponse.json(
          { error: "This conversation is no longer available. The share link might have expired." },
          { status: 404 }
        );
      }

      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    } finally {
      if (browser) {
        await browser?.close();
      }
    }
  } catch (error) {
    console.error('Request error:', error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
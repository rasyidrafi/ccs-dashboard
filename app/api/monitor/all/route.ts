import { NextRequest, NextResponse } from 'next/server';
import { getConversationStore } from '@/lib/conversation-store';
import { syncLogsToStore } from '@/lib/sync-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const sync = searchParams.get('sync') === 'true';
    const apiKey = searchParams.get('apiKey') || undefined;

    const store = await getConversationStore();
    
    if (sync) {
      await syncLogsToStore(store);
    }

    const logs = store.listConversations(offset, limit, apiKey);
    const total = store.getConversationCount();
    const uniqueApiKeys = store.getUniqueApiKeys();

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      logs,
      total,
      uniqueApiKeys
    }, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load aggregated logs';
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}

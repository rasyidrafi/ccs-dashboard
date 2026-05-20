import { NextRequest, NextResponse } from 'next/server';
import { getConversationStore } from '@/lib/conversation-store';
import { runClassificationBatch } from '@/lib/classifier-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const store = await getConversationStore();
    await runClassificationBatch(store);
    
    return NextResponse.json({
      success: true,
      message: 'Batch classification started/completed'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run classification';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

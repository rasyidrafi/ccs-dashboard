import { NextRequest, NextResponse } from 'next/server';
import { getMonitorPayload } from '@/lib/monitor-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sourceType = searchParams.get('sourceType') || 'ccs-core';
    const fileName = searchParams.get('fileName') || undefined;
    
    const payload = await getMonitorPayload(sourceType, fileName);
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load monitor logs';
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}

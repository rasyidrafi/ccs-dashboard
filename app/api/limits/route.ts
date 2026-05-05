import { NextRequest, NextResponse } from 'next/server';
import { getLimitsPayload } from '@/lib/limits-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const payload = await getLimitsPayload(request.nextUrl.searchParams.has('refresh'));
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load limits',
      },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDashboardPayload, parseDashboardQuery } from '@/lib/dashboard-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const query = parseDashboardQuery(request.nextUrl.searchParams);
    const payload = await getDashboardPayload(query);
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load dashboard';
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}

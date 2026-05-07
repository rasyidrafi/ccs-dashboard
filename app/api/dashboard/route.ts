import { NextRequest, NextResponse } from 'next/server';
import { getDashboardPayload, parseDashboardQuery } from '@/lib/dashboard-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let lastRefreshToken: string | null = null;

export async function GET(request: NextRequest) {
  try {
    const query = parseDashboardQuery(request.nextUrl.searchParams);
    const refreshToken = request.nextUrl.searchParams.get('refresh');
    const forceRefresh = refreshToken !== null && refreshToken !== lastRefreshToken;
    if (forceRefresh) {
      lastRefreshToken = refreshToken;
    }
    const payload = await getDashboardPayload(query, forceRefresh);
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

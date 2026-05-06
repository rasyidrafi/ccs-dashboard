"use client"

import { startTransition, useEffect, useState } from "react"
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChartColumnBig,
  Clock3,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Wallet,
} from "lucide-react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  AppView,
  DashboardKeyRow,
  DashboardModelRow,
  DashboardPayload,
  DashboardSourceBadge,
  DatePreset,
  LimitsAccountRow,
  LimitsAlert,
  LimitsPayload,
} from "@/lib/types"

const DEFAULT_PRESET: DatePreset = "today"
const KEY_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const TALL_PANEL_HEIGHT = "h-[540px]"
const TABLE_PANEL_HEIGHT = "h-[620px]"

function buildQuery(preset: DatePreset, from: string, to: string): string {
  const params = new URLSearchParams()
  params.set("preset", preset)
  if (preset === "custom") {
    if (from) params.set("from", from)
    if (to) params.set("to", to)
  }
  return params.toString()
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value)
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never"
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatDateInputValue(value: string): string {
  if (!value) return "Pick a date"
  return value
}

function parseDateInputValue(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function formatCalendarSelection(date: Date | undefined): string {
  if (!date) return ""
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatRelativeSeconds(seconds: number | null): string {
  if (seconds === null) return "Unknown"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 21600 ? 1 : 0)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

function getSourceBadgeVariant(kind: DashboardSourceBadge["kind"]): "secondary" | "outline" | "destructive" {
  switch (kind) {
    case "live":
      return "secondary"
    case "config":
      return "outline"
    default:
      return "destructive"
  }
}

function getStateBadgeVariant(
  value: DashboardKeyRow["sourceState"] | LimitsAccountRow["status"]
): "secondary" | "outline" | "destructive" {
  switch (value) {
    case "live":
    case "active":
      return "secondary"
    case "config":
      return "outline"
    default:
      return "destructive"
  }
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function SummaryCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string
  value: string
  detail: string
  icon: typeof Activity
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <div className="flex items-start justify-between gap-4">
          <CardTitle className="text-3xl">{value}</CardTitle>
          <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground">
            <Icon />
          </div>
        </div>
      </CardHeader>
      <CardFooter className="border-t text-xs text-muted-foreground">{detail}</CardFooter>
    </Card>
  )
}

function StatusBadges({ badges }: { badges: DashboardSourceBadge[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {badges.map((badge) => (
        <Badge key={`${badge.kind}-${badge.label}`} variant={getSourceBadgeVariant(badge.kind)}>
          {badge.label}
        </Badge>
      ))}
    </div>
  )
}

function DashboardOverview({
  dashboard,
  preset,
  setPreset,
  from,
  setFrom,
  to,
  setTo,
}: {
  dashboard: DashboardPayload | null
  preset: DatePreset
  setPreset: (value: DatePreset) => void
  from: string
  setFrom: (value: string) => void
  to: string
  setTo: (value: string) => void
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_380px]">
      <Card>
        <CardHeader>
          <CardDescription>Usage</CardDescription>
          <CardTitle className="text-3xl">CCS dashboard</CardTitle>
          <div className="text-sm text-muted-foreground">
            Shared-key traffic, spend concentration, model mix, and source health in one operator view.
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {dashboard ? <StatusBadges badges={dashboard.source.badges} /> : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricItem label="Range" value={dashboard?.range.label ?? "Loading"} />
            <MetricItem label="Mode" value={dashboard?.source.mode ?? "Loading"} />
            <MetricItem label="Granularity" value={dashboard?.range.granularity ?? "Loading"} />
            <MetricItem label="Updated" value={dashboard ? formatDateTime(dashboard.generatedAt) : "Loading"} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Window</CardDescription>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="overflow-x-auto pb-1">
            <ToggleGroup
              value={[preset]}
              variant="outline"
              spacing={2}
              className="min-w-max"
              onValueChange={(value) => {
                const nextValue = value[0] as DatePreset | undefined
                if (!nextValue) return
                startTransition(() => setPreset(nextValue))
              }}
            >
              {(["all", "today", "week", "month", "year", "custom"] as DatePreset[]).map((value) => (
                <ToggleGroupItem key={value} value={value} aria-label={`Set ${value} range`}>
                  {value === "all"
                    ? "All time"
                    : value === "today"
                      ? "Today"
                      : value === "week"
                        ? "This Week"
                        : value === "month"
                          ? "This month"
                          : value === "year"
                            ? "This Year"
                            : value === "custom"
                              ? "Custom"
                              : value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <DatePicker value={from} onChange={setFrom} label="From date" />
            <DatePicker value={to} onChange={setTo} label="To date" />
          </div>
        </CardContent>
        <CardFooter className="border-t text-xs text-muted-foreground">
          Custom dates apply only when <span className="font-medium text-foreground">Custom</span> is selected.
        </CardFooter>
      </Card>
    </section>
  )
}

function DatePicker({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (value: string) => void
  label: string
}) {
  const selected = parseDateInputValue(value)

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" className="w-full justify-between font-normal" />}>
        <span>{formatDateInputValue(value)}</span>
        <CalendarDays data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => onChange(formatCalendarSelection(date))}
        />
      </PopoverContent>
    </Popover>
  )
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  )
}

function DashboardTrend({ dashboard }: { dashboard: DashboardPayload }) {
  const chartData = dashboard.trend.map((point) => ({
    label: point.label,
    requests: point.requests,
    cost: Number(point.cost.toFixed(2)),
  }))

  const chartConfig = {
    requests: { label: "Requests", color: "var(--chart-1)" },
    cost: { label: "Cost", color: "var(--chart-2)" },
  } satisfies ChartConfig

  return (
    <Card className={TALL_PANEL_HEIGHT}>
      <CardHeader>
        <CardDescription>Trend</CardDescription>
        <CardTitle>Requests and spend</CardTitle>
        <CardAction>
          <Badge variant="outline">{dashboard.range.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <ChartContainer config={chartConfig} className="h-full w-full">
          <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-requests)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-requests)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-cost)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-cost)" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis yAxisId="left" tickLine={false} axisLine={false} />
            <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span>{name === "cost" ? "Cost" : "Requests"}</span>
                      <span className="font-mono">
                        {name === "cost" ? formatCost(Number(value)) : formatNumber(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="requests"
              stroke="var(--color-requests)"
              fill="url(#fillRequests)"
              strokeWidth={2}
            />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="cost"
              stroke="var(--color-cost)"
              fill="url(#fillCost)"
              strokeWidth={2}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function TopKeys({ keys }: { keys: DashboardKeyRow[] }) {
  const rows = keys.slice(0, 5).map((row, index) => ({
    name: row.displayName,
    cost: Number(row.cost.toFixed(2)),
    requests: row.requests,
    fill: KEY_COLORS[index % KEY_COLORS.length],
  }))

  const chartConfig = {
    cost: { label: "Cost", color: "var(--chart-1)" },
  } satisfies ChartConfig

  return (
    <Card className={TALL_PANEL_HEIGHT}>
      <CardHeader>
        <CardDescription>Concentration</CardDescription>
        <CardTitle>Top keys by cost</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <ChartContainer config={chartConfig} className="h-[220px] w-full">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 4 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide />
            <YAxis dataKey="name" type="category" width={90} tickLine={false} axisLine={false} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatter={(value) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span>Cost</span>
                      <span className="font-mono">{formatCost(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="cost" radius={10}>
              {rows.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 pr-3">
            {rows.map((row) => (
              <div key={row.name} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.name}</div>
                  <div className="text-xs text-muted-foreground">{formatNumber(row.requests)} requests</div>
                </div>
                <div className="text-sm font-medium">{formatCost(row.cost)}</div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function ModelMix({ models }: { models: DashboardModelRow[] }) {
  const totalCost = models.reduce((sum, row) => sum + row.cost, 0)
  const rows = models.slice(0, 5).map((row, index) => ({
    model: row.model,
    cost: row.cost,
    tokens: row.tokens,
    share: totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0,
    fill: KEY_COLORS[index % KEY_COLORS.length],
  }))

  const chartConfig = {
    cost: { label: "Cost", color: "var(--chart-2)" },
  } satisfies ChartConfig

  return (
    <Card className={TABLE_PANEL_HEIGHT}>
      <CardHeader>
        <CardDescription>Model mix</CardDescription>
        <CardTitle>Spend allocation</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <ChartContainer config={chartConfig} className="h-[220px] w-full">
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span>{String(name)}</span>
                      <span className="font-mono">{formatCost(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <Pie data={rows} dataKey="cost" nameKey="model" innerRadius={58} outerRadius={92} paddingAngle={3}>
              {rows.map((entry) => (
                <Cell key={entry.model} fill={entry.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 pr-3">
            {rows.map((row) => (
              <div key={row.model} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.model}</div>
                  <div className="text-xs text-muted-foreground">{formatTokenCount(row.tokens)} tokens</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">{formatCost(row.cost)}</div>
                  <div className="text-xs text-muted-foreground">{row.share}%</div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function UsageTable({ keys }: { keys: DashboardKeyRow[] }) {
  const [sortBy, setSortBy] = useState<"cost" | "lastActive">("cost")

  const sortedKeys = [...keys].sort((left, right) => {
    if (sortBy === "lastActive") {
      const leftTime = left.lastUsed ? new Date(left.lastUsed).getTime() : 0
      const rightTime = right.lastUsed ? new Date(right.lastUsed).getTime() : 0
      return rightTime - leftTime
    }

    return right.cost - left.cost
  })

  return (
    <Card className={TABLE_PANEL_HEIGHT}>
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardDescription>Per-key detail</CardDescription>
            <CardTitle>Usage table</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Order by</span>
            <Select value={sortBy} onValueChange={(value) => setSortBy(value as "cost" | "lastActive")}>
              <SelectTrigger className="min-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="cost">Cost</SelectItem>
                  <SelectItem value="lastActive">Last active</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky top-0 z-10 bg-card">Key</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card">Provider</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card text-right">Requests</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card text-right">Tokens</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card text-right">Cost</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card">Models</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card">Last used</TableHead>
                <TableHead className="sticky top-0 z-10 bg-card">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedKeys.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-normal">
                    <div className="font-medium">{row.displayName}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{row.maskedKey}</div>
                  </TableCell>
                  <TableCell>{row.providerLabel}</TableCell>
                  <TableCell className="text-right">{formatNumber(row.requests)}</TableCell>
                  <TableCell className="text-right">{formatTokenCount(row.totalTokens)}</TableCell>
                  <TableCell className="text-right">{formatCost(row.cost)}</TableCell>
                  <TableCell className="max-w-[220px] whitespace-normal text-muted-foreground">
                    {row.modelsUsed.join(", ") || "—"}
                  </TableCell>
                  <TableCell>{formatDateTime(row.lastUsed)}</TableCell>
                  <TableCell>
                    <Badge variant={getStateBadgeVariant(row.sourceState)}>{row.sourceState}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function DashboardView({
  dashboard,
  dashboardLoading,
  dashboardError,
  preset,
  setPreset,
  from,
  setFrom,
  to,
  setTo,
}: {
  dashboard: DashboardPayload | null
  dashboardLoading: boolean
  dashboardError: string | null
  preset: DatePreset
  setPreset: (value: DatePreset) => void
  from: string
  setFrom: (value: string) => void
  to: string
  setTo: (value: string) => void
}) {
  return (
    <div className="space-y-4">
      <DashboardOverview
        dashboard={dashboard}
        preset={preset}
        setPreset={setPreset}
        from={from}
        setFrom={setFrom}
        to={to}
        setTo={setTo}
      />

      {dashboard?.source.note ? (
        <Alert>
          <Activity />
          <AlertTitle>Collection note</AlertTitle>
          <AlertDescription>{dashboard.source.note}</AlertDescription>
        </Alert>
      ) : null}

      {dashboardError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Dashboard request failed</AlertTitle>
          <AlertDescription>{dashboardError}</AlertDescription>
        </Alert>
      ) : null}

      {dashboardLoading && !dashboard ? <LoadingGrid /> : null}

      {dashboard ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            <SummaryCard
              title="Requests"
              value={formatNumber(dashboard.summary.totalRequests)}
              detail="Total request volume in the selected range."
              icon={ChartColumnBig}
            />
            <SummaryCard
              title="Tokens"
              value={formatTokenCount(dashboard.summary.totalTokens)}
              detail="Input, output, and cache tokens combined."
              icon={Activity}
            />
            <SummaryCard
              title="Estimated cost"
              value={formatCost(dashboard.summary.totalCost)}
              detail="Provider-aware spend estimate."
              icon={Wallet}
            />
            <SummaryCard
              title="Active keys"
              value={formatNumber(dashboard.summary.activeKeys)}
              detail="Keys that handled traffic in this window."
              icon={KeyRound}
            />
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
            <DashboardTrend dashboard={dashboard} />
            <div className="space-y-4">
              <TopKeys keys={dashboard.keys} />
            </div>
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
            <UsageTable keys={dashboard.keys} />
            <ModelMix models={dashboard.models} />
          </div>
        </>
      ) : null}
    </div>
  )
}

function LimitsAlertCard({ alert }: { alert: LimitsAlert }) {
  return (
    <Alert variant={alert.severity === "urgent" ? "destructive" : "default"}>
      {alert.severity === "urgent" ? <ShieldAlert /> : <AlertTriangle />}
      <AlertTitle>{alert.accountLabel}</AlertTitle>
      <AlertDescription>
        <span className="block font-medium text-foreground">{alert.title}</span>
        <span className="block">{alert.message}</span>
      </AlertDescription>
    </Alert>
  )
}

function QuotaProgress({
  label,
  value,
  helper,
}: {
  label: string
  value: number | null
  helper: string
}) {
  if (value === null) {
    return (
      <div className="space-y-2 rounded-lg border border-border/70 p-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>{label}</span>
          <span className="text-muted-foreground">Unavailable</span>
        </div>
        <Progress value={0} />
        <div className="text-xs text-muted-foreground">{helper}</div>
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="font-medium">{Math.round(value)}% left</span>
      </div>
      <Progress value={value} />
      <div className="text-xs text-muted-foreground">{helper}</div>
    </div>
  )
}

function LimitsAccountCard({ account }: { account: LimitsAccountRow }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>Account</CardDescription>
        <CardTitle>{account.displayName}</CardTitle>
        <CardAction className="flex flex-col items-end gap-2">
          <Badge variant={getStateBadgeVariant(account.status)}>{account.status}</Badge>
          <Badge variant="outline">{account.planType || "unknown plan"}</Badge>
        </CardAction>
        <div className="text-sm text-muted-foreground">{account.email || account.sourceLabel}</div>
      </CardHeader>
      <CardContent className="space-y-4">
        {account.alert ? <LimitsAlertCard alert={account.alert} /> : null}

        {account.error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Account error</AlertTitle>
            <AlertDescription>{account.error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-3">
            <QuotaProgress
              label="5 hour window"
              value={account.fiveHour?.remainingPercent ?? null}
              helper={
                account.fiveHour
                  ? `Used ${Math.round(account.fiveHour.usedPercent)}%, resets in ${formatRelativeSeconds(account.fiveHour.resetAfterSeconds)}`
                  : "No live 5-hour window"
              }
            />
            <QuotaProgress
              label="Weekly window"
              value={account.weekly?.remainingPercent ?? null}
              helper={
                account.weekly
                  ? `Used ${Math.round(account.weekly.usedPercent)}%, resets in ${formatRelativeSeconds(account.weekly.resetAfterSeconds)}`
                  : "No live weekly window"
              }
            />
          </div>
          <div className="space-y-3">
            <MetricItem label="Recent success" value={formatNumber(account.successCount)} />
            <MetricItem label="Recent failures" value={formatNumber(account.failureCount)} />
            <MetricItem label="Last activity" value={formatDateTime(account.updatedAt)} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LimitsView({
  limits,
  limitsLoading,
  limitsError,
}: {
  limits: LimitsPayload | null
  limitsLoading: boolean
  limitsError: string | null
}) {
  return (
    <div className="space-y-4">
      {limitsError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Limits request failed</AlertTitle>
          <AlertDescription>{limitsError}</AlertDescription>
        </Alert>
      ) : null}

      {limitsLoading && !limits ? <LoadingGrid /> : null}

      {limits ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            <SummaryCard
              title="Registered accounts"
              value={formatNumber(limits.summary.totalAccounts)}
              detail="Every discovered Codex auth file."
              icon={KeyRound}
            />
            <SummaryCard
              title="Active sessions"
              value={formatNumber(limits.summary.activeAccounts)}
              detail="Accounts currently returning live quota."
              icon={Activity}
            />
            <SummaryCard
              title="Reset soon"
              value={formatNumber(limits.summary.resetSoonCount)}
              detail="Accounts worth using before weekly reset."
              icon={Clock3}
            />
            <SummaryCard
              title="Weekly exhausted"
              value={formatNumber(limits.summary.exhaustedWeeklyCount)}
              detail="Accounts with no weekly headroom left."
              icon={ShieldAlert}
            />
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
            <Card>
              <CardHeader>
                <CardDescription>Priority board</CardDescription>
                <CardTitle>Use-before-reset alerts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {limits.alerts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No reset urgency right now.
                  </div>
                ) : (
                  limits.alerts.map((alert) => <LimitsAlertCard key={alert.id} alert={alert} />)
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardDescription>Inventory</CardDescription>
                <CardTitle>Status mix</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <MetricItem label="Updated" value={formatDateTime(limits.generatedAt)} />
                <MetricItem
                  label="Healthy"
                  value={formatNumber(limits.accounts.filter((account) => account.status === "active").length)}
                />
                <MetricItem
                  label="Expired"
                  value={formatNumber(limits.accounts.filter((account) => account.status === "expired").length)}
                />
                <MetricItem
                  label="Errors"
                  value={formatNumber(limits.accounts.filter((account) => account.status === "error").length)}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardDescription>Registered accounts</CardDescription>
              <CardTitle>Quota runway</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {limits.accounts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No Codex accounts were discovered.
                </div>
              ) : (
                limits.accounts.map((account) => <LimitsAccountCard key={account.id} account={account} />)
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

export function DashboardClient() {
  const [view, setView] = useState<AppView>("dashboard")
  const [preset, setPreset] = useState<DatePreset>(DEFAULT_PRESET)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [refreshToken, setRefreshToken] = useState(0)

  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)

  const [limits, setLimits] = useState<LimitsPayload | null>(null)
  const [limitsError, setLimitsError] = useState<string | null>(null)
  const [limitsLoading, setLimitsLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setDashboardLoading(true)
    setDashboardError(null)

    fetch(`/api/dashboard?${buildQuery(preset, from, to)}&refresh=${refreshToken}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `Request failed with ${response.status}`)
        }
        return response.json() as Promise<DashboardPayload>
      })
      .then((data) => setDashboard(data))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setDashboardError(error instanceof Error ? error.message : "Failed to load dashboard")
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDashboardLoading(false)
        }
      })

    return () => controller.abort()
  }, [preset, from, to, refreshToken])

  useEffect(() => {
    if (view !== "limits" && limits) return
    const controller = new AbortController()
    setLimitsLoading(true)
    setLimitsError(null)

    fetch(`/api/limits?refresh=${refreshToken}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `Request failed with ${response.status}`)
        }
        return response.json() as Promise<LimitsPayload>
      })
      .then((data) => setLimits(data))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLimitsError(error instanceof Error ? error.message : "Failed to load limits")
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLimitsLoading(false)
        }
      })

    return () => controller.abort()
  }, [view, refreshToken])

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-6">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-medium">CCS Manager Console</div>
            <div className="text-sm text-muted-foreground">
              Dashboard and quota visibility for shared CLIProxy and Codex usage
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <Tabs value={view} onValueChange={(value) => setView(value as AppView)}>
              <TabsList>
                <TabsTrigger value="dashboard">
                  <ChartColumnBig />
                  Dashboard
                </TabsTrigger>
                <TabsTrigger value="limits">
                  <ShieldAlert />
                  Limits
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <Button variant="outline" onClick={() => setRefreshToken((value) => value + 1)}>
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {view === "dashboard" ? (
        <DashboardView
          dashboard={dashboard}
          dashboardLoading={dashboardLoading}
          dashboardError={dashboardError}
          preset={preset}
          setPreset={setPreset}
          from={from}
          setFrom={setFrom}
          to={to}
          setTo={setTo}
        />
      ) : (
        <LimitsView limits={limits} limitsLoading={limitsLoading} limitsError={limitsError} />
      )}
    </main>
  )
}

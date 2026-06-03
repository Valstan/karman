'use client';

import { Bar, BarChart, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

const statusConfig = {
  active: { label: 'Активные', color: 'var(--chart-1)' },
  overdue: { label: 'Просроченные', color: 'var(--chart-5)' },
  closed: { label: 'Закрытые', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const bankConfig = {
  remaining: { label: 'Остаток', color: 'var(--chart-2)' },
} satisfies ChartConfig;

export function DashboardCharts({
  creditsByStatus,
  perBank,
}: {
  creditsByStatus: { active: number; overdue: number; closed: number };
  perBank: { bankName: string; remaining: string }[];
}) {
  const statusData = [
    { status: 'active', value: creditsByStatus.active },
    { status: 'overdue', value: creditsByStatus.overdue },
    { status: 'closed', value: creditsByStatus.closed },
  ].filter((d) => d.value > 0);

  const bankData = perBank.map((b) => ({ bankName: b.bankName, remaining: Number(b.remaining) }));

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Кредиты по статусам</CardTitle>
        </CardHeader>
        <CardContent>
          {statusData.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Нет данных</p>
          ) : (
            <ChartContainer config={statusConfig} className="mx-auto aspect-square max-h-[240px]">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="status" />} />
                <Pie data={statusData} dataKey="value" nameKey="status" innerRadius={55}>
                  {statusData.map((entry) => (
                    <Cell key={entry.status} fill={`var(--color-${entry.status})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Остаток по банкам</CardTitle>
        </CardHeader>
        <CardContent>
          {bankData.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Нет данных</p>
          ) : (
            <ChartContainer config={bankConfig} className="max-h-[240px] w-full">
              <BarChart accessibilityLayer data={bankData} layout="vertical" margin={{ left: 12 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="bankName"
                  tickLine={false}
                  axisLine={false}
                  width={90}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="remaining" fill="var(--color-remaining)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

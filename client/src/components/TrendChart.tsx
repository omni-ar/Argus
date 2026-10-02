import { useMemo } from 'react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Legend
} from 'recharts';
import type { ValidatorResult } from '../api';
import { Activity } from 'lucide-react';

interface TrendChartProps {
  results: ValidatorResult[];
}

const COLORS = [
  'hsl(var(--accent))',
  'hsl(var(--destructive))',
  '#3fb950', // success (green)
  '#d29922', // warning (yellow)
  '#bc8cff', // purple
  '#ff7b72', // coral
  '#79c0ff', // light blue
];

export function TrendChart({ results }: TrendChartProps) {
  
  // Transform data for Recharts: We want each X-axis point to be an epoch,
  // and the Y-axis to be the effectiveness % for each validator at that epoch
  // However, Recharts expects an array of objects like: { epoch: 433000, val1: 100, val2: 95 }
  // So we group by epoch.
  const chartData = useMemo(() => {
    const epochMap = new Map<number, any>();
    
    // First, find all unique epochs across all valid validators
    results.forEach(val => {
      if (val.error) return;
      
      val.epochs.forEach(ep => {
        if (!epochMap.has(ep.epoch)) {
           // Initialize with the epoch number
          epochMap.set(ep.epoch, { epoch: ep.epoch });
        }
        
        const existingRow = epochMap.get(ep.epoch);
        // Map missType to a rough 'effectiveness score' for that specific epoch
        // For a single epoch, it's either 100% or 0% depending on if they were correct
        const epochScore = ep.missType === 'correct' ? 100 : 0;
        
        existingRow[`val_${val.validatorIndex}`] = epochScore;
      });

      // Explicitly mark missing epochs with null so we get a broken line
      val.missingEpochs.forEach(missing => {
         if (!epochMap.has(missing.epoch)) {
            epochMap.set(missing.epoch, { epoch: missing.epoch });
         }
         const existingRow = epochMap.get(missing.epoch);
         existingRow[`val_${val.validatorIndex}`] = null;
      });
    });

    // Convert map to sorted array
    const sortedData = Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);
    
    // Now, a single epoch's binary [0, 100] is very noisy.
    // Let's compute a rolling average (e.g. over 5 epochs) so the trend line is smoother.
    const SMOOTHING_WINDOW = 5;
    
    const smoothedData = sortedData.map((row, index) => {
      const smoothedRow: any = { epoch: row.epoch };
      
      results.forEach(val => {
        if (val.error) return;
        const key = `val_${val.validatorIndex}`;
        
        let sum = 0;
        let count = 0;
        
        // Look back N epochs
        for (let i = Math.max(0, index - SMOOTHING_WINDOW + 1); i <= index; i++) {
          const valAtI = sortedData[i][key];
          if (valAtI !== undefined && valAtI !== null) {
            sum += valAtI;
            count++;
          }
        }
        
        smoothedRow[key] = count > 0 ? Number((sum / count).toFixed(1)) : null;
      });
      
      return smoothedRow;
    });

    return smoothedData;
  }, [results]);

  const validResults = results.filter(r => !r.error);

  if (validResults.length === 0) {
    return (
      <div className="h-96 flex flex-col items-center justify-center text-muted-foreground border-dashed border-2 rounded-xl">
        <Activity className="opacity-20 mb-4 animate-pulse" size={48} />
        <p>Not enough data to generate trend chart</p>
      </div>
    );
  }

  // Custom generic tooltip for dark theme
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-popover/90 border border-border p-4 rounded-lg shadow-lg backdrop-blur-sm">
          <p className="text-muted-foreground text-xs uppercase tracking-wider mb-2 font-semibold font-mono">Epoch {label}</p>
          <div className="space-y-1.5">
            {payload.map((entry: any, index: number) => (
              <div key={`item-${index}`} className="flex items-center gap-2 text-sm justify-between w-40">
                <span className="flex items-center gap-1.5 font-mono">
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                  {entry.name.replace('val_', '#')}
                </span>
                <span className="font-semibold text-foreground">{entry.value}%</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="h-full flex flex-col pt-4">
       <div className="px-6 pb-2 flex justify-between items-center relative z-10">
          <h3 className="font-semibold text-lg flex items-center gap-2 text-foreground">
            <Activity size={18} className="text-primary" />
             Effectiveness Trend
          </h3>
          <span className="text-xs text-muted-foreground font-mono bg-secondary px-2 py-0.5 rounded-md">5-Epoch Rolling Avg</span>
       </div>
       
      <div className="h-80 w-full p-4 pr-6 pb-2 relative group w-full">
         <div className="absolute inset-0 bg-gradient-to-t from-secondary/30 to-transparent pointer-events-none" />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.6} />
            <XAxis 
              dataKey="epoch" 
              stroke="hsl(var(--muted-foreground))" 
              fontSize={11} 
              tickMargin={10}
              tickFormatter={(val) => `${val}`}
              axisLine={false}
              tickLine={false}
              minTickGap={30}
            />
            <YAxis 
              domain={[80, 100]} 
              stroke="hsl(var(--muted-foreground))" 
              fontSize={11} 
              tickMargin={10}
              tickFormatter={(val) => `${val}%`}
              axisLine={false}
              tickLine={false}
              orientation='right'
              width={45}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }} />
            <Legend 
               wrapperStyle={{ paddingTop: '10px', fontSize: '12px', color: 'hsl(var(--foreground))' }} 
               formatter={(value) => <span className="text-muted-foreground ml-1">{value.replace('val_', 'Validator ')}</span>}
               iconType="circle"
               iconSize={8}
            />
            
            {validResults.map((val, index) => (
              <Line
                key={val.validatorIndex}
                type="monotone"
                dataKey={`val_${val.validatorIndex}`}
                name={`val_${val.validatorIndex}`}
                stroke={COLORS[index % COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5, strokeWidth: 0, className: "animate-pulse" }}
                connectNulls={false} // Explicitly break the line on nulls (missing epochs)
                animationDuration={1500}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

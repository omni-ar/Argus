import type { ValidatorResult } from '../api';
import { ShieldCheck, ArrowDownToLine, ZapOff, XCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';

interface ValidatorCardProps {
  validator: ValidatorResult;
}

export function ValidatorCard({ validator }: ValidatorCardProps) {
  const { validatorIndex, pubkey, summary, error } = validator;

  const truncateKey = (key: string) => {
    if (!key) return '';
    if (key.length <= 12) return key;
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  };

  if (error) {
    return (
      <Card className="border-destructive/30 bg-secondary/50 flex flex-col justify-center items-center h-full p-6">
        <XCircle className="text-destructive mb-2 animate-pulse" size={28} />
        <h3 className="font-mono font-semibold mb-1">Index {validatorIndex}</h3>
        <p className="text-xs font-mono text-muted-foreground mb-3">{truncateKey(pubkey)}</p>
        <Badge variant="destructive" className="py-1 px-3 text-center">{error}</Badge>
      </Card>
    );
  }

  // Calculate effectiveness % (correct / checked)
  const effectiveness = summary.epochsChecked > 0 
    ? ((summary.correct / summary.epochsChecked) * 100).toFixed(1)
    : '0.0';



  const isHighEffectiveness = Number(effectiveness) > 99;
  const isMedEffectiveness = Number(effectiveness) > 90 && !isHighEffectiveness;

  return (
    <Card className="flex flex-col h-full animate-fade-in hover:shadow-lg hover:-translate-y-1 transition-all duration-300 relative overflow-hidden group">
      {/* Decorative top border glow */}
      <div className={cn(
        "absolute top-0 left-0 right-0 h-1 transition-colors duration-300",
        isHighEffectiveness ? "bg-green-500" : isMedEffectiveness ? "bg-yellow-500" : "bg-destructive"
      )} />

      <CardContent className="p-4 pt-5 flex flex-col flex-1">
        <div className="flex justify-between items-start mb-4 gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck size={18} className="text-accent shrink-0" />
              <h3 className="font-bold text-lg font-mono truncate">#{validatorIndex}</h3>
            </div>
            <p className="text-sm font-mono text-muted-foreground truncate" title={pubkey}>
              {truncateKey(pubkey)}
            </p>
          </div>
          
          <div className={cn(
            "flex flex-col items-end p-1.5 rounded-md transition-colors min-w-[70px]",
            isHighEffectiveness ? "bg-green-500/10 text-green-500" : 
            isMedEffectiveness ? "bg-yellow-500/10 text-yellow-500" : "bg-destructive/10 text-destructive"
          )}>
            <span className="text-xl font-bold leading-none">{effectiveness}%</span>
            <span className="text-[9px] font-medium uppercase tracking-wider opacity-80 mt-1">Effectiveness</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-secondary/50 rounded-md p-3 flex flex-col justify-between group-hover:bg-secondary transition-colors overflow-hidden">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] mb-1 uppercase tracking-wide whitespace-nowrap">
              <ArrowDownToLine size={12} className="shrink-0" />
              <span>Total Missed</span>
            </div>
            <span className="font-mono font-medium text-yellow-500 group-hover:-translate-y-0.5 transition-transform truncate text-sm" title={`${summary.totalMissedGwei} Gwei`}>
              {summary.totalMissedEth} ETH
            </span>
          </div>
          
          <div className="bg-secondary/50 rounded-md p-3 flex flex-col justify-between group-hover:bg-secondary transition-colors overflow-hidden">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] mb-1 uppercase tracking-wide whitespace-nowrap">
              <ZapOff size={12} className="shrink-0" />
              <span>Missed Entirely</span>
            </div>
            <span className="font-mono font-medium text-destructive group-hover:-translate-y-0.5 transition-transform text-sm">{summary.missed}</span>
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-border mt-2">
          <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Attestation Breakdown</h4>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-2 gap-y-2">
            <div className="flex flex-col items-center justify-center p-1.5 rounded bg-secondary/30 relative overflow-hidden group/item cursor-default text-center">
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-destructive/0 group-hover/item:bg-destructive/50 transition-colors" />
              <span className="text-[9px] text-muted-foreground mb-0.5 leading-tight">Wrong Head</span>
              <span className={cn("font-bold text-xs", summary.wrongHead > 0 ? "text-destructive" : "text-foreground")}>
                {summary.wrongHead}
              </span>
            </div>
            <div className="flex flex-col items-center justify-center p-1.5 rounded bg-secondary/30 relative overflow-hidden group/item cursor-default text-center">
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-yellow-500/0 group-hover/item:bg-yellow-500/50 transition-colors" />
              <span className="text-[9px] text-muted-foreground mb-0.5 leading-tight">Wrong Target</span>
              <span className={cn("font-bold text-xs", summary.wrongTarget > 0 ? "text-yellow-500" : "text-foreground")}>
                {summary.wrongTarget}
              </span>
            </div>
            <div className="flex flex-col items-center justify-center p-1.5 rounded bg-secondary/30 relative overflow-hidden group/item cursor-default text-center">
               <div className="absolute inset-x-0 bottom-0 h-0.5 bg-red-400/0 group-hover/item:bg-red-400/50 transition-colors" />
               <span className="text-[9px] text-muted-foreground mb-0.5 leading-tight">Wrong Source</span>
               <span className={cn("font-bold text-xs", summary.wrongSource > 0 ? "text-red-400" : "text-foreground")}>
                 {summary.wrongSource}
               </span>
            </div>
            <div className="flex flex-col items-center justify-center p-1.5 rounded bg-secondary/30 relative overflow-hidden group/item cursor-default text-center">
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-yellow-400/0 group-hover/item:bg-yellow-400/50 transition-colors" />
              <span className="text-[9px] text-muted-foreground mb-0.5 leading-tight">Late Head</span>
              <span className={cn("font-bold text-xs", summary.lateHead > 0 ? "text-yellow-400" : "text-foreground")}>
                {summary.lateHead}
              </span>
            </div>
            <div className="flex flex-col items-center justify-center p-1.5 rounded bg-secondary/30 relative overflow-hidden group/item cursor-default text-center">
               <div className="absolute inset-x-0 bottom-0 h-0.5 bg-orange-400/0 group-hover/item:bg-orange-400/50 transition-colors" />
               <span className="text-[9px] text-muted-foreground mb-0.5 leading-tight">Late Source</span>
               <span className={cn("font-bold text-xs", summary.lateSource > 0 ? "text-orange-400" : "text-foreground")}>
                 {summary.lateSource}
               </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

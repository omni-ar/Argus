import { useState } from 'react';
import { useValidatorPerformance } from '../hooks/useValidatorPerformance';
import { ValidatorCard } from './ValidatorCard';
import { TrendChart } from './TrendChart';
import { EpochTable } from './EpochTable';
import { Loader } from './Loader';
import { ErrorAlert } from './ErrorAlert';
import { CalendarDays, Activity, ShieldAlert } from 'lucide-react';
import { Card } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function Dashboard() {
  const { data, isLoading, error, params, setParams, refetch } = useValidatorPerformance({ minutes: 30 });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  // We determine what the "current value" of the select is based on the params
  const isCustomRange = params.fromEpoch !== undefined || params.toEpoch !== undefined;
  let selectValue = "custom";
  if (!isCustomRange) {
    if (params.minutes === 30) selectValue = "30m";
    else if (params.days) selectValue = String(params.days);
  }

  const handleApplyCustom = () => {
    const from = parseInt(customFrom, 10);
    const to = customTo ? parseInt(customTo, 10) : undefined;
    
    if (isNaN(from) || from < 0) return; // Simple validation
    
    setParams({ fromEpoch: from, toEpoch: to });
    setIsPopoverOpen(false);
  };

  const handleSelectChange = (val: string) => {
    if (val === "custom") {
       setIsPopoverOpen(true);
    } else if (val === "30m") {
       setParams({ minutes: 30 });
    } else {
       setParams({ days: Number(val) });
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center">
          <Loader size={48} text={`Loading data for ${isCustomRange ? 'custom epoch range' : `the last ${params.days} days`}...`} />
        </div>
      );
    }

    if (error) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-4">
          <ErrorAlert message={error} onRetry={refetch} />
        </div>
      );
    }

    if (!data || !data.results) {
      return null;
    }

    const { results } = data;
    const missingValidators = results.filter(r => r.error);
    const validValidators = results.filter(r => !r.error);
    const isSnapshot = validValidators.some(r => r.dataSource === 'local_snapshot');

    return (
      <div className="flex flex-col gap-8 animate-fade-in">
        
        {/* Alerts for validators that completely failed to load */}
        {missingValidators.length > 0 && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 flex items-start gap-3">
             <ShieldAlert className="text-destructive shrink-0 mt-0.5" size={20} />
             <div>
               <h4 className="font-semibold text-destructive text-sm">Validator Lookup Failed</h4>
               <p className="text-muted-foreground text-sm mt-1">
                 {missingValidators.length} validator(s) could not be found or encountered an error.
               </p>
             </div>
          </div>
        )}

        {isSnapshot && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-sm text-muted-foreground">
            Showing the included reconciliation snapshot (10 epochs from March 2026). Live provider data is unavailable on the free tier.
          </div>
        )}

        {/* Top: Summary Cards */}
        <section>
          <div className="flex items-center gap-2 mb-4 px-1">
             <Activity size={18} className="text-muted-foreground" />
             <h2 className="text-xl font-semibold">Validator Overview</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {results.map((validator) => (
              <ValidatorCard key={validator.validatorIndex} validator={validator} />
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          {/* Left/Top: Trend Chart (takes up more space) */}
          <section className="xl:col-span-2">
            <h2 className="text-xl font-semibold mb-4 px-1">Performance Trend</h2>
            <Card className="p-0 overflow-hidden relative group border-border/50 bg-card">
               {/* Decorative subtle border top */}
               <div className="absolute top-0 inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
               <TrendChart results={validValidators} />
            </Card>
          </section>

          {/* Right/Bottom: Aggregate Stats (Optional extra panel) */}
          <section className="xl:col-span-1">
             <h2 className="text-xl font-semibold mb-4 px-1">Aggregate Summary</h2>
             <Card className="h-[calc(100%-2.5rem)] flex flex-col justify-center items-center text-center p-8 bg-gradient-to-b from-card to-card/50 border-border/50">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 ring-1 ring-primary/20 shadow-[0_0_20px_rgba(255,255,255,0.05)]">
                   <Activity className="text-primary" size={32} />
                </div>
                <h3 className="text-3xl font-bold font-mono text-foreground mb-2">
                   {validValidators.length}
                </h3>
                <p className="text-muted-foreground uppercase tracking-wider text-xs font-semibold mb-8">Active Validators</p>
                
                <div className="w-full space-y-4">
                   <div className="flex justify-between items-center border-b border-border/50 pb-2">
                      <span className="text-sm text-muted-foreground">Time Range</span>
                      <span className="font-mono text-sm">{isCustomRange ? 'Custom Range' : `${params.days} Days`}</span>
                   </div>
                   <div className="flex justify-between items-center border-b border-border/50 pb-2">
                      <span className="text-sm text-muted-foreground">Total Epochs</span>
                      <span className="font-mono text-sm">{validValidators.reduce((acc, v) => acc + v.epochs.length, 0)}</span>
                   </div>
                   <div className="flex justify-between items-center pb-1">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-destructive/80" /> Total Gaps</span>
                      <span className="font-mono text-sm text-destructive">{validValidators.reduce((acc, v) => acc + v.missingEpochs.length, 0)}</span>
                   </div>
                </div>
             </Card>
          </section>
        </div>

        {/* Bottom: Detailed Table */}
        <section className="mb-8">
           <EpochTable results={validValidators} />
        </section>
      </div>
    );
  };

  return (
    <div className="container py-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent inline-block">
            Validator Dashboard
          </h1>
          <p className="text-muted-foreground mt-1 max-w-xl">
            Live attestation performance, missed ETH, and detailed epoch tracking.
          </p>
        </div>

        <div className="flex items-center gap-3 bg-card p-1.5 rounded-lg border border-border/50 shadow-sm relative">
          <div className="bg-secondary p-2 rounded-md">
             <CalendarDays className="text-muted-foreground" size={18} />
          </div>
          
          <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
            <PopoverTrigger asChild>
              <div className="absolute right-0 top-0 h-full w-10 z-0 pointer-events-none" />
            </PopoverTrigger>
            <PopoverContent className="w-80" align="end">
              <div className="grid gap-4">
                <div className="space-y-2">
                  <h4 className="font-medium leading-none">Custom Epoch Range</h4>
                  <p className="text-sm text-muted-foreground">
                    Query a specific range of epochs.
                  </p>
                </div>
                <div className="grid gap-2">
                  <div className="grid grid-cols-3 items-center gap-4">
                    <Label htmlFor="fromEpoch">From</Label>
                    <Input
                      id="fromEpoch"
                      placeholder="e.g. 300000"
                      className="col-span-2 h-8"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      type="number"
                    />
                  </div>
                  <div className="grid grid-cols-3 items-center gap-4">
                    <Label htmlFor="toEpoch">To <span className="text-muted-foreground text-xs">(Opt)</span></Label>
                    <Input
                      id="toEpoch"
                      placeholder="e.g. 300100"
                      className="col-span-2 h-8"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      type="number"
                    />
                  </div>
                  <Button onClick={handleApplyCustom} size="sm" className="mt-2" disabled={!customFrom}>
                    Apply Range
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Select value={selectValue} onValueChange={handleSelectChange} disabled={isLoading}>
            <SelectTrigger className="w-[180px] border-none bg-transparent shadow-none focus:ring-0 z-10">
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30m">Last 30 Mins (Default)</SelectItem>
              <SelectItem value="1">Last 24 Hours</SelectItem>
              <SelectItem value="3">Last 3 Days</SelectItem>
              <SelectItem value="7">Last 7 Days</SelectItem>
              <SelectItem value="14">Last 14 Days</SelectItem>
              <SelectItem value="30">Last 30 Days</SelectItem>
              <SelectItem value="90">Last 3 Months</SelectItem>
              <SelectItem value="custom" className="font-medium text-primary">Custom Epoch Range...</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <main className="relative">
        {/* Subtle background glow effect */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4 bg-primary/5 rounded-full blur-[100px] pointer-events-none -z-10" />
        {renderContent()}
      </main>
    </div>
  );
}

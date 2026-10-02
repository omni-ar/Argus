import { useState, useMemo } from 'react';
import type { ValidatorResult, EpochData } from '../api';
import { CheckCircle2, XCircle, MinusCircle, ArrowUpDown } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface EpochTableProps {
  results: ValidatorResult[];
}

type SortField = 'epoch' | 'validatorIndex' | 'missType' | 'totalMissedGwei';
type SortOrder = 'asc' | 'desc';

interface FlattenedEpoch {
  validatorIndex: number;
  pubkey: string;
  epoch: number;
  data: EpochData | null;
  isMissing: boolean;
  missingReason?: string;
  id: string; // unique key
}

export function EpochTable({ results }: EpochTableProps) {
  const [filterValidator, setFilterValidator] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('epoch');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Flatten all epochs from all validators into a single sortable array
  const allEpochs = useMemo(() => {
    const flattened: FlattenedEpoch[] = [];
    
    results.forEach(val => {
      if (val.error) return; // Skip failed validators
      
      // Add successful epochs
      val.epochs.forEach(ep => {
        flattened.push({
          validatorIndex: val.validatorIndex,
          pubkey: val.pubkey,
          epoch: ep.epoch,
          data: ep,
          isMissing: false,
          id: `${val.validatorIndex}-${ep.epoch}`
        });
      });

      // Add explicit missing gaps
      val.missingEpochs.forEach(missing => {
        flattened.push({
          validatorIndex: val.validatorIndex,
          pubkey: val.pubkey,
          epoch: missing.epoch,
          data: null,
          isMissing: true,
          missingReason: missing.reason,
          id: `${val.validatorIndex}-${missing.epoch}-missing`
        });
      });
    });

    return flattened;
  }, [results]);

  // Apply filters and sorting
  const filteredAndSorted = useMemo(() => {
    let processed = [...allEpochs];

    if (filterValidator !== 'all') {
      const targetIndex = parseInt(filterValidator, 10);
      processed = processed.filter(e => e.validatorIndex === targetIndex);
    }

    processed.sort((a, b) => {
      let valA: any = a[sortField as keyof FlattenedEpoch];
      let valB: any = b[sortField as keyof FlattenedEpoch];

      if (sortField === 'totalMissedGwei') {
        valA = a.data ? Number(a.data.missed.total) : 0;
        valB = b.data ? Number(b.data.missed.total) : 0;
      } else if (sortField === 'missType') {
        valA = a.data?.missType || 'missing';
        valB = b.data?.missType || 'missing';
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return processed;
  }, [allEpochs, filterValidator, sortField, sortOrder]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc'); // Default new sorts to desc
    }
  };

  const formatGwei = (strGwei: string) => {
    const num = Number(strGwei) / 1e9;
    if (num === 0) return '-';
    if (num < 0.00001) return '< 0.00001';
    return num.toFixed(5);
  };

  const getStatusIcon = (status: boolean | null | undefined) => {
    if (status === true) return <CheckCircle2 size={16} className="text-green-500 mx-auto" />;
    if (status === false) return <XCircle size={16} className="text-destructive mx-auto" />;
    return <MinusCircle size={16} className="text-muted-foreground mx-auto opacity-50" />;
  };

  const getMissTypeBadge = (type: string) => {
    switch (type) {
      case 'correct': return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">Optimal</Badge>;
      case 'missing': return <Badge variant="outline" className="border-dashed text-muted-foreground">Missing Data</Badge>;
      case 'missed': 
      case 'missed_entirely': return <Badge variant="destructive">Missed Entirely</Badge>;
      case 'late_source': return <Badge variant="secondary" className="bg-orange-500/10 text-orange-500 border-orange-500/20">Late Source</Badge>;
      case 'late_head': return <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Late Head</Badge>;
      default: return <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 hover:bg-yellow-500/20">{type.replace('_', ' ')}</Badge>;
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => (
    <ArrowUpDown 
      size={14} 
      className={cn(
        "inline ml-1 transition-colors", 
        sortField === field ? "text-primary" : "text-muted-foreground group-hover:text-foreground opacity-50 group-hover:opacity-100"
      )} 
    />
  );

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <div className="flex justify-between items-center px-1">
        <h3 className="font-semibold text-lg flex items-center gap-2">
          Epoch Details
          <span className="text-xs font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
            {filteredAndSorted.length} records
          </span>
        </h3>
        <div className="hidden sm:block">
          <Select value={filterValidator} onValueChange={setFilterValidator}>
            <SelectTrigger className="w-[200px] font-mono">
              <SelectValue placeholder="All Validators" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Validators ({results.filter(r => !r.error).length})</SelectItem>
              {results.filter(r => !r.error).map(v => (
                <SelectItem key={v.validatorIndex} value={v.validatorIndex.toString()}>
                  #{v.validatorIndex} ({v.pubkey.slice(0,6)}...)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="cursor-pointer group whitespace-nowrap" onClick={() => toggleSort('epoch')}>
                Epoch <SortIcon field="epoch" />
              </TableHead>
              <TableHead className="cursor-pointer group whitespace-nowrap" onClick={() => toggleSort('validatorIndex')}>
                Validator <SortIcon field="validatorIndex" />
              </TableHead>
              <TableHead className="text-center whitespace-nowrap">Head</TableHead>
              <TableHead className="text-center whitespace-nowrap">Target</TableHead>
              <TableHead className="text-center whitespace-nowrap">Source</TableHead>
              <TableHead className="cursor-pointer group text-right whitespace-nowrap" onClick={() => toggleSort('totalMissedGwei')}>
                Missed (ETH) <SortIcon field="totalMissedGwei" />
              </TableHead>
              <TableHead className="cursor-pointer group whitespace-nowrap" onClick={() => toggleSort('missType')}>
                Status <SortIcon field="missType" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.length === 0 ? (
               <TableRow>
                 <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                   No epoch data found for the selected criteria.
                 </TableCell>
               </TableRow>
            ) : filteredAndSorted.map((row) => (
              <TableRow key={row.id} className={cn(
                row.isMissing ? "bg-muted/50" : "",
                row.data && row.data.missType !== 'correct' ? "bg-destructive/5" : ""
              )}>
                <TableCell className="font-mono text-muted-foreground">
                  {row.epoch}
                </TableCell>
                <TableCell className="font-mono font-medium">
                  #{row.validatorIndex}
                </TableCell>
                
                {row.isMissing ? (
                  <TableCell colSpan={5} className="text-muted-foreground text-sm max-w-md truncate relative">
                    <span className="relative z-10 flex items-center gap-2">
                       <MinusCircle size={14} className="text-border" />
                       Data gap: {row.missingReason || 'Unknown error'}
                    </span>
                  </TableCell>
                ) : (
                  <>
                    <TableCell className="text-center">
                      <div className="flex justify-center transform transition-transform hover:scale-110">{getStatusIcon(row.data?.headCorrect)}</div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex justify-center transform transition-transform hover:scale-110">{getStatusIcon(row.data?.targetCorrect)}</div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex justify-center transform transition-transform hover:scale-110">{getStatusIcon(row.data?.sourceCorrect)}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <span className={cn(
                        Number(row.data?.missed.total) > 0 ? "text-yellow-500 font-medium" : "text-muted-foreground"
                      )}>
                        {formatGwei(row.data?.missed.total || '0')}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center">
                        {getMissTypeBadge(row.data?.missType || 'unknown')}
                      </div>
                    </TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

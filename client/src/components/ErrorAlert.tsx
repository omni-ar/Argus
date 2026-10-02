import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';

interface ErrorAlertProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  return (
    <Card className="max-w-md w-full border-destructive/30 bg-destructive/5 text-destructive-foreground">
      <CardContent className="pt-6 flex flex-col items-center text-center">
        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4 text-destructive">
          <AlertTriangle size={24} />
        </div>
        <h3 className="font-semibold text-lg text-destructive mb-2">Error Loading Data</h3>
        <p className="text-sm text-destructive/80 mb-6">{message}</p>
        
        {onRetry && (
          <Button 
            onClick={onRetry}
            variant="outline"
            className="w-full gap-2 text-foreground border-border hover:bg-secondary"
          >
            <RefreshCw size={16} />
            Try Again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

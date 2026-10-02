import { Activity } from 'lucide-react';

interface LoaderProps {
  size?: number;
  text?: string;
}

export function Loader({ size = 32, text = 'Loading...' }: LoaderProps) {
  return (
    <div className="flex flex-col items-center justify-center space-y-4 animate-fade-in p-8">
      <div className="relative">
        <Activity 
          size={size} 
          className="text-primary animate-pulse relative z-10" 
        />
        <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full scale-150 animate-pulse -z-10" />
      </div>
      {text && <p className="text-muted-foreground font-mono text-sm animate-pulse">{text}</p>}
    </div>
  );
}

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Download } from 'lucide-react';

export default function OutlookAddinDownloadPage() {
  return (
    <div className="container max-w-4xl space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Nava Outlook Assistant</h1>
        <p className="text-muted-foreground text-sm">
          Integrate Nava AI Reservationist directly into your Classic Outlook 2016 desktop sidebar.
        </p>
      </div>

      <Card className="border-amber-500/30 bg-amber-950/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Download className="h-5 w-5 text-amber-500" />
            Install Nava for Outlook 2016
          </CardTitle>
          <CardDescription>
            Zero-admin per-user installer. No IT administrator password required.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild size="lg" className="bg-amber-600 text-white hover:bg-amber-500">
            <a href="/download/NavaOutlookSetup.exe" download="NavaOutlookSetup.exe">
              <Download className="mr-2 h-4 w-4" />
              Download Nava Outlook Assistant (.exe)
            </a>
          </Button>

          <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 md:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-400">
                  1
                </span>
                Step 1: Download
              </div>
              <p className="text-muted-foreground text-xs">
                Click the button above to download <code>NavaOutlookSetup.exe</code> onto your PC.
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-400">
                  2
                </span>
                Step 2: Run Installer
              </div>
              <p className="text-muted-foreground text-xs">
                Double-click the downloaded file and click “Install”. Setup finishes in 5 seconds without admin prompts.
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-400">
                  3
                </span>
                Step 3: Launch Outlook
              </div>
              <p className="text-muted-foreground text-xs">
                Open Outlook 2016. The Nava Assistant pane will appear docked on the right-hand side automatically.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

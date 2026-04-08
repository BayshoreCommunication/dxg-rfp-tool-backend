# patch_controller.ps1 - patches createProposal to auto-load user Settings

$file = "controller\proposalsController.ts"
$content = Get-Content -Raw $file

# Normalize to LF for matching
$content_norm = $content -replace "`r`n", "`n"

$old = "    // Attach the authenticated user if available`n    if (userId) {`n      body.userId = userId;`n    }`n`n    const proposal = new Proposal(body);`n    await proposal.save();"

$new = @"
    // Attach the authenticated user if available
    if (userId) {
      body.userId = userId;

      // -- Auto-populate proposalSetting from the user's Settings --
      let userSettings = await Settings.findOne({ userId });
      if (!userSettings) {
        userSettings = await Settings.create({ userId });
      }

      body.proposalSetting = {
        branding: {
          brandName: userSettings.branding?.brandName ?? "",
          linkPrefix: userSettings.branding?.linkPrefix ?? "",
          defaultFont: userSettings.branding?.defaultFont ?? "",
          signatureColor: userSettings.branding?.signatureColor ?? "",
          buttonTextColor: userSettings.branding?.buttonTextColor ?? "",
          logoFile: userSettings.branding?.logoFile ?? null,
        },
        proposals: {
          proposalLanguage: userSettings.proposals?.proposalLanguage ?? "",
          defaultCurrency: userSettings.proposals?.defaultCurrency ?? "",
          expiryDate: userSettings.proposals?.expiryDate ?? "",
          priceSeparator: userSettings.proposals?.priceSeparator ?? "",
          dateFormat: userSettings.proposals?.dateFormat ?? "",
          decimalPrecision: userSettings.proposals?.decimalPrecision ?? "",
          contacts: {
            email: {
              enabled: userSettings.proposals?.contacts?.email?.enabled ?? false,
              value: userSettings.proposals?.contacts?.email?.value ?? "",
            },
            call: {
              enabled: userSettings.proposals?.contacts?.call?.enabled ?? false,
              value: userSettings.proposals?.contacts?.call?.value ?? "",
            },
            whatsapp: {
              enabled: userSettings.proposals?.contacts?.whatsapp?.enabled ?? false,
              value: userSettings.proposals?.contacts?.whatsapp?.value ?? "",
            },
          },
          redirectUrl: userSettings.proposals?.redirectUrl ?? "",
          redirectDelay: userSettings.proposals?.redirectDelay ?? "0",
          downloadPreviewTop: userSettings.proposals?.downloadPreviewTop ?? "",
          teammateEmail: userSettings.proposals?.teammateEmail ?? "",
          downloadPreviewBottom: userSettings.proposals?.downloadPreviewBottom ?? "",
          enableAiAssistant: userSettings.proposals?.enableAiAssistant ?? false,
        },
        signatures: {
          signatureType: userSettings.signatures?.signatureType ?? "",
          prospectOptions: userSettings.signatures?.prospectOptions ?? [],
          signatureText: userSettings.signatures?.signatureText ?? "",
        },
      };
    }

    const proposal = new Proposal(body);
    await proposal.save();
"@

if ($content_norm.Contains($old)) {
    $patched = $content_norm.Replace($old, $new)
    # Write back with LF endings
    [System.IO.File]::WriteAllText((Resolve-Path $file), $patched)
    Write-Host "SUCCESS: createProposal patched."
} else {
    Write-Host "ERROR: Target block not found. Dumping context..."
    $idx = $content_norm.IndexOf("Attach the authenticated user")
    Write-Host "Found 'Attach' at char index: $idx"
    Write-Host ($content_norm.Substring([Math]::Max(0,$idx-20), [Math]::Min(300, $content_norm.Length - [Math]::Max(0,$idx-20))))
}

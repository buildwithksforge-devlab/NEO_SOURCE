param(
    [string]$PrinterName,
    [string]$FilePath,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$Source = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NeoRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDocName;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pOutputFile;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDataType;
    }

    [DllImport(
        "winspool.drv",
        EntryPoint = "OpenPrinterW",
        SetLastError = true,
        CharSet = CharSet.Unicode
    )]
    private static extern bool OpenPrinter(
        string printerName,
        out IntPtr printer,
        IntPtr defaults
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "ClosePrinter",
        SetLastError = true
    )]
    private static extern bool ClosePrinter(
        IntPtr printer
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "StartDocPrinterW",
        SetLastError = true,
        CharSet = CharSet.Unicode
    )]
    private static extern int StartDocPrinter(
        IntPtr printer,
        int level,
        ref DOC_INFO_1 document
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "EndDocPrinter",
        SetLastError = true
    )]
    private static extern bool EndDocPrinter(
        IntPtr printer
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "StartPagePrinter",
        SetLastError = true
    )]
    private static extern bool StartPagePrinter(
        IntPtr printer
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "EndPagePrinter",
        SetLastError = true
    )]
    private static extern bool EndPagePrinter(
        IntPtr printer
    );

    [DllImport(
        "winspool.drv",
        EntryPoint = "WritePrinter",
        SetLastError = true
    )]
    private static extern bool WritePrinter(
        IntPtr printer,
        IntPtr bytes,
        int count,
        out int written
    );

    private static void LastError(
        string operation
    )
    {
        throw new Win32Exception(
            Marshal.GetLastWin32Error(),
            operation
        );
    }

    public static void Send(
        string printerName,
        byte[] data
    )
    {
        IntPtr printer = IntPtr.Zero;
        IntPtr unmanaged = IntPtr.Zero;
        bool documentStarted = false;
        bool pageStarted = false;

        try
        {
            if (!OpenPrinter(
                printerName,
                out printer,
                IntPtr.Zero
            ))
            {
                LastError("OpenPrinter failed");
            }

            DOC_INFO_1 document =
                new DOC_INFO_1
                {
                    pDocName = "NEO Print Job",
                    pOutputFile = null,
                    pDataType = "RAW"
                };

            if (StartDocPrinter(
                printer,
                1,
                ref document
            ) == 0)
            {
                LastError(
                    "StartDocPrinter failed"
                );
            }

            documentStarted = true;

            if (!StartPagePrinter(printer))
            {
                LastError(
                    "StartPagePrinter failed"
                );
            }

            pageStarted = true;

            unmanaged =
                Marshal.AllocHGlobal(
                    data.Length
                );

            Marshal.Copy(
                data,
                0,
                unmanaged,
                data.Length
            );

            int written;

            if (!WritePrinter(
                printer,
                unmanaged,
                data.Length,
                out written
            ))
            {
                LastError(
                    "WritePrinter failed"
                );
            }

            if (written != data.Length)
            {
                throw new InvalidOperationException(
                    "Windows spooler accepted only "
                    + written
                    + " of "
                    + data.Length
                    + " bytes."
                );
            }
        }
        finally
        {
            if (unmanaged != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(
                    unmanaged
                );
            }

            if (pageStarted)
            {
                EndPagePrinter(printer);
            }

            if (documentStarted)
            {
                EndDocPrinter(printer);
            }

            if (printer != IntPtr.Zero)
            {
                ClosePrinter(printer);
            }
        }
    }
}
"@

Add-Type `
    -TypeDefinition $Source `
    -Language CSharp

if ($ValidateOnly) {
    Write-Host "RAW spooler bridge compiled successfully."
    return
}

if ([string]::IsNullOrWhiteSpace($PrinterName)) {
    throw "PrinterName is required."
}

if (
    [string]::IsNullOrWhiteSpace($FilePath) -or
    -not (
        Test-Path `
            -LiteralPath $FilePath `
            -PathType Leaf
    )
) {
    throw "RAW print file not found: $FilePath"
}

$ResolvedFile = (
    Resolve-Path -LiteralPath $FilePath
).Path

$Bytes = [System.IO.File]::ReadAllBytes(
    $ResolvedFile
)

[NeoRawPrinter]::Send(
    $PrinterName,
    $Bytes
)
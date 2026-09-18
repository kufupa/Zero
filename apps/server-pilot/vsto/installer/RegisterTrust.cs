using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;

namespace NavaOutlookInstaller
{
    internal static class RegisterTrust
    {
        private const string AddinKey = @"Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin";

        public static int Main(string[] args)
        {
            try
            {
                string app = args != null && args.Length > 0 && !string.IsNullOrWhiteSpace(args[0])
                    ? args[0]
                    : Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "NavaOutlookAddin");
                app = Path.GetFullPath(app);
                string cer = Path.Combine(app, "NavaOutlookAddin.cer");
                string vsto = Path.Combine(app, "NavaOutlookAddin.vsto");
                if (!File.Exists(vsto))
                {
                    Console.Error.WriteLine("Missing " + vsto);
                    return 2;
                }

                UnblockTree(app);
                string uri = new Uri(vsto).AbsoluteUri + "|vstolocal";
                WriteAddinRegistration(uri);
                WriteResiliency();

                if (!File.Exists(cer))
                {
                    Console.Error.WriteLine("Missing " + cer);
                    return 3;
                }

                var cert = new X509Certificate2(cer);
                AddToStore(StoreName.TrustedPublisher, cert);
                try
                {
                    AddToStore(StoreName.Root, cert);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("Root store skipped: " + ex.Message);
                }

                string publicKey = BitConverter.ToString(cert.GetPublicKey()).Replace("-", "");
                WriteInclusionList(new Uri(vsto).AbsoluteUri, publicKey);
                TryUserInclusionList(new Uri(vsto).AbsoluteUri, publicKey);
                Console.WriteLine("Trusted Nava Outlook Assistant for this Windows user.");
                Console.WriteLine("Manifest=" + uri);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        private static void AddToStore(StoreName name, X509Certificate2 cert)
        {
            using (var store = new X509Store(name, StoreLocation.CurrentUser))
            {
                store.Open(OpenFlags.ReadWrite);
                store.Add(cert);
            }
        }

        private static void WriteAddinRegistration(string manifestUri)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(AddinKey))
            {
                if (key == null) throw new InvalidOperationException("Cannot write " + AddinKey);
                key.SetValue("FriendlyName", "Nava AI Reservationist", RegistryValueKind.String);
                key.SetValue("Description", "Nava AI Assistant for Classic Outlook 2016", RegistryValueKind.String);
                key.SetValue("LoadBehavior", 3, RegistryValueKind.DWord);
                key.SetValue("Manifest", manifestUri, RegistryValueKind.String);
            }
        }

        private static void WriteResiliency()
        {
            foreach (string version in new[] { "15.0", "16.0" })
            {
                string path = @"Software\Microsoft\Office\" + version + @"\Outlook\Resiliency\DoNotDisableAddinList";
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(path))
                {
                    if (key != null) key.SetValue("NavaOutlookAddin", 1, RegistryValueKind.DWord);
                }
            }
        }

        private static void WriteInclusionList(string vstoUri, string publicKey)
        {
            string valueName = vstoUri + ", PublicKey=" + publicKey;
            foreach (string path in new[]
            {
                @"Software\Microsoft\VSTA\Security\InclusionList",
                @"Software\Microsoft\VSTO\Security\InclusionList"
            })
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(path))
                {
                    if (key != null) key.SetValue(valueName, 1, RegistryValueKind.DWord);
                }
            }
        }

        private static void TryUserInclusionList(string vstoUri, string publicKey)
        {
            string[] names =
            {
                "Microsoft.VisualStudio.Tools.Office.Runtime.v4.0.Framework",
                "Microsoft.VisualStudio.Tools.Applications.Runtime"
            };
            foreach (string name in names)
            {
                try
                {
                    Assembly asm = Assembly.Load(name);
                    Type listType = asm.GetType("Microsoft.VisualStudio.Tools.Office.Runtime.Security.UserInclusionList")
                        ?? asm.GetType("Microsoft.VisualStudio.Tools.Applications.Runtime.Security.UserInclusionList");
                    Type entryType = asm.GetType("Microsoft.VisualStudio.Tools.Office.Runtime.Security.AddInSecurityEntry")
                        ?? asm.GetType("Microsoft.VisualStudio.Tools.Applications.Runtime.Security.AddInSecurityEntry");
                    if (listType == null || entryType == null) continue;
                    object entry = Activator.CreateInstance(entryType, vstoUri, publicKey);
                    MethodInfo add = listType.GetMethod("Add", BindingFlags.Public | BindingFlags.Static);
                    if (add != null)
                    {
                        add.Invoke(null, new[] { entry });
                        Console.WriteLine("UserInclusionList.Add ok via " + name);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("UserInclusionList skip " + name + ": " + ex.Message);
                }
            }
        }

        private static void UnblockTree(string root)
        {
            try
            {
                foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
                {
                    try { File.Delete(file + ":Zone.Identifier"); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
            }
            catch (IOException) { }
        }
    }
}

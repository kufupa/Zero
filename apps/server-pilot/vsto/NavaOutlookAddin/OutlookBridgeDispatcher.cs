using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Outlook = Microsoft.Office.Interop.Outlook;

namespace NavaOutlookAddin
{
    public class OutlookBridgeDispatcher
    {
        private readonly Outlook.Application _application;
        private readonly JavaScriptSerializer _serializer;
        private const int BRIDGE_VERSION = 1;
        private const string PR_TRANSPORT_MESSAGE_HEADERS = "http://schemas.microsoft.com/mapi/proptag/0x007D001F";
        private const string PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F";

        public OutlookBridgeDispatcher(Outlook.Application application)
        {
            _application = application;
            _serializer = new JavaScriptSerializer { MaxJsonLength = 10 * 1024 * 1024 };
        }

        public string Dispatch(string jsonCommand)
        {
            string requestId = "unknown";
            string action = "";
            try
            {
                var dict = _serializer.Deserialize<Dictionary<string, object>>(jsonCommand);
                requestId = dict.ContainsKey("requestId") ? dict["requestId"]?.ToString() : "req_0";
                action = dict.ContainsKey("action") ? dict["action"]?.ToString() : "";
                var payload = dict.ContainsKey("payload") ? dict["payload"] as Dictionary<string, object> : null;

                object resultData = null;

                switch (action)
                {
                    case "PING":
                        resultData = new Dictionary<string, object>
                        {
                            { "bridgeProtocolVersion", BRIDGE_VERSION },
                            { "version", "1.0.0" },
                            { "outlookVersion", _application.Version },
                            { "workstationUser", Environment.UserName },
                            { "outlookEmail", SafeCurrentUserAddress() }
                        };
                        break;

                    case "GET_ACTIVE_EMAIL":
                        resultData = GetActiveEmail();
                        break;

                    case "GET_EMAIL_BY_ENTRY_ID":
                        string entryId = payload != null && payload.ContainsKey("entryId") ? payload["entryId"]?.ToString() : "";
                        resultData = GetEmailByEntryId(entryId);
                        break;

                    case "GET_FOLDER_EMAILS":
                        string folder = payload != null && payload.ContainsKey("folder") ? payload["folder"]?.ToString() : "Inbox";
                        int count = payload != null && payload.ContainsKey("count") ? Convert.ToInt32(payload["count"]) : 10;
                        resultData = GetFolderEmailsTable(folder, count);
                        break;

                    case "CREATE_DRAFT":
                        resultData = CreateDraft(payload);
                        break;

                    case "CREATE_REPLY_DRAFT":
                        resultData = CreateReplyDraft(payload);
                        break;

                    case "MOVE_EMAIL":
                        resultData = MoveEmail(payload);
                        break;

                    case "MOVE_TO_SPAM":
                        resultData = MoveToSpam(payload);
                        break;

                    case "CREATE_FOLDER":
                        resultData = CreateFolder(payload);
                        break;

                    default:
                        return FormatResponse(requestId, action, false, null, "Unknown action: " + action);
                }

                return FormatResponse(requestId, action, true, resultData, null);
            }
            catch (Exception ex)
            {
                return FormatResponse(requestId, action, false, null, ex.Message);
            }
        }

        public Dictionary<string, object> GetActiveEmail(bool includeBodies = true)
        {
            Outlook.Explorer explorer = null;
            Outlook.Selection selection = null;
            try
            {
                explorer = _application.ActiveExplorer();
                if (explorer == null) return null;

                selection = explorer.Selection;
                if (selection != null && selection.Count > 0)
                {
                    object item = selection[1];
                    if (item is Outlook.MailItem mail)
                    {
                        try { return MapMailItem(mail, includeBodies); }
                        finally { Marshal.ReleaseComObject(mail); }
                    }
                    if (item != null) Marshal.ReleaseComObject(item);
                }
                return null;
            }
            finally
            {
                if (selection != null) Marshal.ReleaseComObject(selection);
                if (explorer != null) Marshal.ReleaseComObject(explorer);
            }
        }

        public Dictionary<string, object> GetEmailByEntryId(string entryId)
        {
            if (string.IsNullOrEmpty(entryId)) return null;
            object item = null;
            try
            {
                item = _application.Session.GetItemFromID(entryId);
                if (item is Outlook.MailItem mail)
                {
                    return MapMailItem(mail, true);
                }
                return null;
            }
            finally
            {
                if (item != null) Marshal.ReleaseComObject(item);
            }
        }

        public List<Dictionary<string, object>> GetFolderEmailsTable(string folderName, int count)
        {
            var list = new List<Dictionary<string, object>>();
            Outlook.MAPIFolder folder = null;
            Outlook.Table table = null;
            Outlook.Columns columns = null;
            try
            {
                folder = ResolveFolder(folderName);
                table = folder.GetTable("[MessageClass] = 'IPM.Note'", Outlook.OlTableContents.olUserItems);
                columns = table.Columns;
                columns.Add("EntryID");
                columns.Add("Subject");
                columns.Add("SenderName");
                columns.Add("ReceivedTime");
                columns.Add(PR_INTERNET_MESSAGE_ID);
                table.Sort("ReceivedTime", true);

                int retrieved = 0;
                while (!table.EndOfTable && retrieved < count)
                {
                    Outlook.Row row = table.GetNextRow();
                    try
                    {
                        list.Add(new Dictionary<string, object>
                        {
                            { "entryId", row["EntryID"]?.ToString() ?? "" },
                            { "subject", row["Subject"]?.ToString() ?? "" },
                            { "senderName", row["SenderName"]?.ToString() ?? "" },
                            { "receivedTime", row["ReceivedTime"] != null ? Convert.ToDateTime(row["ReceivedTime"]).ToString("o") : "" },
                            { "internetMessageId", SafeRowValue(row, PR_INTERNET_MESSAGE_ID) }
                        });
                        retrieved++;
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(row);
                    }
                }
                return list;
            }
            finally
            {
                if (columns != null) Marshal.ReleaseComObject(columns);
                if (table != null) Marshal.ReleaseComObject(table);
                if (folder != null) Marshal.ReleaseComObject(folder);
            }
        }

        public bool CreateDraft(Dictionary<string, object> payload)
        {
            Outlook.MailItem draft = null;
            try
            {
                draft = (Outlook.MailItem)_application.CreateItem(Outlook.OlItemType.olMailItem);
                if (payload != null)
                {
                    if (payload.ContainsKey("to")) draft.To = payload["to"]?.ToString();
                    if (payload.ContainsKey("subject")) draft.Subject = payload["subject"]?.ToString();
                    if (payload.ContainsKey("htmlBody")) draft.HTMLBody = payload["htmlBody"]?.ToString();
                }
                draft.Save();
                return true;
            }
            finally
            {
                if (draft != null) Marshal.ReleaseComObject(draft);
            }
        }

        public bool CreateReplyDraft(Dictionary<string, object> payload)
        {
            string entryId = payload != null && payload.ContainsKey("entryId") ? payload["entryId"]?.ToString() : "";
            if (string.IsNullOrEmpty(entryId)) return false;

            object item = null;
            Outlook.MailItem reply = null;
            try
            {
                item = _application.Session.GetItemFromID(entryId);
                if (item is Outlook.MailItem mail)
                {
                    reply = mail.Reply();
                    if (payload.ContainsKey("htmlBody"))
                    {
                        reply.HTMLBody = payload["htmlBody"]?.ToString() + reply.HTMLBody;
                    }
                    reply.Display();
                    return true;
                }
                return false;
            }
            finally
            {
                if (reply != null) Marshal.ReleaseComObject(reply);
                if (item != null) Marshal.ReleaseComObject(item);
            }
        }

        public bool MoveEmail(Dictionary<string, object> payload)
        {
            string entryId = payload != null && payload.ContainsKey("entryId") ? payload["entryId"]?.ToString() : "";
            string folderName = payload != null && payload.ContainsKey("folderName") ? payload["folderName"]?.ToString() : "";
            if (string.IsNullOrEmpty(entryId) || string.IsNullOrEmpty(folderName)) return false;

            object item = null;
            Outlook.MAPIFolder targetFolder = null;
            try
            {
                item = _application.Session.GetItemFromID(entryId);
                targetFolder = ResolveFolder(folderName);
                if (item is Outlook.MailItem mail && targetFolder != null)
                {
                    mail.Move(targetFolder);
                    return true;
                }
                return false;
            }
            finally
            {
                if (targetFolder != null) Marshal.ReleaseComObject(targetFolder);
                if (item != null) Marshal.ReleaseComObject(item);
            }
        }

        public bool MoveToSpam(Dictionary<string, object> payload)
        {
            if (payload == null) payload = new Dictionary<string, object>();
            payload["folderName"] = "Junk";
            return MoveEmail(payload);
        }

        public bool CreateFolder(Dictionary<string, object> payload)
        {
            string name = payload != null && payload.ContainsKey("newFolderName") ? payload["newFolderName"]?.ToString() : "Nava Folders";
            Outlook.MAPIFolder root = null;
            Outlook.MAPIFolder newFolder = null;
            Outlook.Folders folders = null;
            try
            {
                root = (Outlook.MAPIFolder)_application.Session.DefaultStore.GetRootFolder();
                folders = root.Folders;
                newFolder = folders.Add(name, Outlook.OlDefaultFolders.olFolderInbox);
                return true;
            }
            finally
            {
                if (newFolder != null) Marshal.ReleaseComObject(newFolder);
                if (folders != null) Marshal.ReleaseComObject(folders);
                if (root != null) Marshal.ReleaseComObject(root);
            }
        }

        private Outlook.MAPIFolder ResolveFolder(string folderName)
        {
            string key = (folderName ?? "Inbox").Trim();
            if (key.Length == 0) key = "Inbox";

            if (LooksLikeInbox(key))
            {
                return _application.Session.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderInbox);
            }
            if (LooksLikeJunk(key))
            {
                return _application.Session.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderJunk);
            }
            if (string.Equals(key, "Sent", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(key, "Sent Items", StringComparison.OrdinalIgnoreCase))
            {
                return _application.Session.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderSentMail);
            }
            if (string.Equals(key, "Drafts", StringComparison.OrdinalIgnoreCase))
            {
                return _application.Session.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderDrafts);
            }

            Outlook.MAPIFolder root = null;
            Outlook.Folders folders = null;
            try
            {
                root = (Outlook.MAPIFolder)_application.Session.DefaultStore.GetRootFolder();
                folders = root.Folders;
                return folders[key];
            }
            finally
            {
                if (folders != null) Marshal.ReleaseComObject(folders);
                if (root != null) Marshal.ReleaseComObject(root);
            }
        }

        private static bool LooksLikeInbox(string key)
        {
            return string.Equals(key, "Inbox", StringComparison.OrdinalIgnoreCase);
        }

        private static bool LooksLikeJunk(string key)
        {
            return string.Equals(key, "Junk", StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, "Spam", StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, "Junk Email", StringComparison.OrdinalIgnoreCase);
        }

        private Dictionary<string, object> MapMailItem(Outlook.MailItem mail, bool includeBodies)
        {
            string headers = "";
            string msgId = "";
            Outlook.PropertyAccessor accessor = null;
            try
            {
                accessor = mail.PropertyAccessor;
                headers = accessor?.GetProperty(PR_TRANSPORT_MESSAGE_HEADERS)?.ToString() ?? "";
                msgId = accessor?.GetProperty(PR_INTERNET_MESSAGE_ID)?.ToString() ?? "";
            }
            catch
            {
                // POP3 stores may omit transport headers.
            }
            finally
            {
                if (accessor != null) Marshal.ReleaseComObject(accessor);
            }

            return new Dictionary<string, object>
            {
                { "entryId", mail.EntryID ?? "" },
                { "subject", mail.Subject ?? "" },
                { "senderEmail", mail.SenderEmailAddress ?? "" },
                { "senderName", mail.SenderName ?? "" },
                { "to", mail.To ?? "" },
                { "cc", mail.CC ?? "" },
                { "receivedTime", mail.ReceivedTime.ToString("o") },
                { "bodyText", mail.Body ?? "" },
                { "bodyHtml", includeBodies ? (mail.HTMLBody ?? "") : "" },
                { "conversationId", mail.ConversationID ?? "" },
                { "internetMessageId", msgId },
                { "transportHeaders", headers }
            };
        }

        private string SafeCurrentUserAddress()
        {
            Outlook.Recipient currentUser = null;
            try
            {
                currentUser = _application.Session.CurrentUser;
                return currentUser?.Address ?? "unknown";
            }
            catch
            {
                return "unknown";
            }
            finally
            {
                if (currentUser != null) Marshal.ReleaseComObject(currentUser);
            }
        }

        private static string SafeRowValue(Outlook.Row row, string column)
        {
            try
            {
                return row[column]?.ToString() ?? "";
            }
            catch
            {
                return "";
            }
        }

        private string FormatResponse(string requestId, string action, bool success, object data, string error)
        {
            var resp = new Dictionary<string, object>
            {
                { "requestId", requestId },
                { "version", BRIDGE_VERSION },
                { "action", action },
                { "success", success },
                { "data", data },
                { "error", error }
            };
            return _serializer.Serialize(resp);
        }
    }
}

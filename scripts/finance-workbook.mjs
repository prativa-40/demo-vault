import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [mode, inputPath, outputPath] = process.argv.slice(2);
const sections = [
  ["Banking accounts", ["Family Member", "Bank Name", "Account Number / ID", "Account Type"]],
  ["Credit cards", ["Family Member", "Bank Name", "Card Number", "Card Network", "Expiry Date"]],
  ["Debit cards", ["Family Member", "Bank Name", "Card Number", "Card Network", "Expiry Date"]],
  ["Forex Cards", ["Family Member", "Provider", "Card Number", "Currency", "Expiry Date"]],
  ["UPI", ["Family Member", "UPI ID", "Provider", "Bank Name"]],
  ["Fixed Deposits", ["Family Member", "Bank Name", "FD / Certificate Number", "Deposit Amount", "Maturity Date"]],
  ["PPF Account", ["Family Member", "Bank Name", "Account Number / ID"]],
  ["EPF Account", ["Family Member", "UAN Number"]],
  ["NPS Account", ["Family Member", "Bank Name", "Account Number / ID"]],
  ["Demat Account", ["Family Member", "Bank Name", "Account Number / ID"]],
  ["Postoffice Savings", ["Family Member", "Account Number / ID"]],
  ["Insurance policies", ["Family Member", "Policy ID", "Policy Name", "Maturity Date"]]
];

const lastColumn = count => String.fromCharCode(64 + count);
const emptyRows = count => Array.from({length:100}, () => Array(count).fill(""));

if (mode === "build") {
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const memberNames = (input.members || []).map(member => member.name);
  const workbook = Workbook.create();
  for (const [name, headers] of sections) {
    const sheet = workbook.worksheets.add(name);
    const end = lastColumn(headers.length);
    sheet.showGridLines = false;
    sheet.getRange(`A1:${end}1`).merge();
    sheet.getRange("A1").values = [[`Hearth Finance Import - ${name}`]];
    sheet.getRange(`A2:${end}2`).merge();
    sheet.getRange("A2").values = [["One row equals one record. Select a family member, enter only the fields needed for this Finance subsection, then upload the workbook in Hearth."]];
    sheet.getRange(`A4:${end}4`).values = [headers];
    sheet.getRange(`A5:${end}104`).values = emptyRows(headers.length);
    sheet.getRange(`A1:${end}1`).format = {fill:"#155B4B",font:{bold:true,color:"#FFFFFF",size:16},horizontalAlignment:"center",verticalAlignment:"center"};
    sheet.getRange(`A2:${end}2`).format = {fill:"#EAF3EB",font:{color:"#355B4D",italic:true},wrapText:true};
    sheet.getRange(`A4:${end}4`).format = {fill:"#DCECDF",font:{bold:true,color:"#18312B"},wrapText:true,borders:{preset:"outside",style:"thin",color:"#B9CEC1"}};
    sheet.getRange(`A5:${end}104`).format = {borders:{preset:"inside",style:"thin",color:"#E4E7DF"}};
    headers.forEach((header,index)=>{if(header.includes("Date"))sheet.getRange(`${lastColumn(index+1)}5:${lastColumn(index+1)}104`).setNumberFormat("yyyy-mm-dd")});
    sheet.getRange("A:A").format.columnWidth = 24;
    sheet.getRange(`B:${end}`).format.columnWidth = 20;
    sheet.getRange("A1").format.rowHeight = 28;
    sheet.getRange("A2").format.rowHeight = 34;
    sheet.getRange("A5:A104").dataValidation = {rule:{type:"list",values:memberNames}};
    sheet.freezePanes.freezeRows(4);
  }
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
} else if (mode === "read") {
  const input = await FileBlob.load(inputPath);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const rows = [];
  for (const [name, headers] of sections) {
    const sheet = workbook.worksheets.getItem(name);
    if (!sheet) continue;
    const values = sheet.getUsedRange(true).values || [];
    const headerRow = values.findIndex(row => row?.[0] === "Family Member");
    if (headerRow < 0) continue;
    rows.push(...values.slice(headerRow + 1).filter(row => row?.some(value => value !== "" && value != null)).map(row => {const raw=Object.fromEntries(headers.map((header,index)=>[header,row[index]??""]));return {"Finance Subsection":name,"Family Member":raw["Family Member"]||"","Bank Name":raw["Bank Name"]||"","Account Number / ID":raw["Account Number / ID"]||raw["FD / Certificate Number"]||"","Account Type":raw["Account Type"]||"","UAN Number":raw["UAN Number"]||"","Policy ID":raw["Policy ID"]||"","Policy Name":raw["Policy Name"]||"","Maturity Date":raw["Maturity Date"]||"","Card Number":raw["Card Number"]||"","Card Network / Currency":raw["Card Network"]||raw["Currency"]||"","Expiry Date":raw["Expiry Date"]||"","UPI ID":raw["UPI ID"]||"","Provider":raw["Provider"]||""}}));
  }
  await fs.writeFile(outputPath, JSON.stringify(rows));
} else {
  throw new Error("Use build or read mode.");
}

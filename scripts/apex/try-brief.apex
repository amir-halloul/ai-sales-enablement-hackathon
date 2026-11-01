// Generates a brief for the next OSF Digital meeting and prints it. Run with:
//   sf apex run --file scripts/apex/try-brief.apex --target-org osfDev
Event meeting = [SELECT Id FROM Event WHERE Subject = 'Analytics renewal review' ORDER BY CreatedDate DESC LIMIT 1];
MeetingBriefService.Result result = MeetingBriefService.generateBrief(meeting.Id, null);
System.debug('RESULT ' + JSON.serialize(result));
Meeting_Brief__c brief = MeetingBriefService.findLatest(meeting.Id);
System.debug('STATUSES overview=' + brief.Overview_Status__c + ' conversations=' + brief.Conversations_Status__c
    + ' health=' + brief.Account_Health_Status__c + ' signals=' + brief.Company_Signals_Status__c + ' approach=' + brief.Approach_Status__c);
for (String line : MeetingBriefFormatter.toText(brief).split('\n')) {
    System.debug('BRIEF ' + line);
}

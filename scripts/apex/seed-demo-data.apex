// Demo data for the Acme Cloud meeting brief MVP. Run with:
//   sf apex run --file scripts/apex/seed-demo-data.apex --target-org osfDev
// Accounts and leads are real companies and public executives so the enrichment API finds them.
// Contacts, deals, conversations and meetings are fictional. Re-running deletes and recreates the demo data,
// including the earlier fictional accounts.
Set<String> demoAccounts = new Set<String>{
    'OSF Digital', 'Marks and Spencer', 'Electrolux Group', 'Saint-Gobain',
    'Northwind Traders', 'Bluefin Retail Group', 'Summit Health'
};
delete [SELECT Id FROM Event WHERE AccountId IN (SELECT Id FROM Account WHERE Name IN :demoAccounts)];
delete [SELECT Id FROM Task WHERE AccountId IN (SELECT Id FROM Account WHERE Name IN :demoAccounts)];
delete [SELECT Id FROM Meeting_Brief__c WHERE Account__r.Name IN :demoAccounts];
delete [SELECT Id FROM Conversation__c WHERE Account__r.Name IN :demoAccounts];
delete [SELECT Id FROM Opportunity WHERE Account.Name IN :demoAccounts];
delete [SELECT Id FROM Contact WHERE Account.Name IN :demoAccounts];
delete [SELECT Id FROM Account WHERE Name IN :demoAccounts];
delete [SELECT Id FROM Lead WHERE Email = 'maya.chen@bluefin.example.com' OR Company IN :demoAccounts];

Date today = Date.today();

// Enrichment fields are left blank so the enrichment demo can fill them; ShippingCountry helps matching
// without blocking the billing address, which is only filled when entirely blank.
Account osf = new Account(Name = 'OSF Digital', Website = 'https://osf.digital', ShippingCountry = 'Canada', Industry = 'Consulting');
Account mands = new Account(Name = 'Marks and Spencer', Website = 'https://www.marksandspencer.com', ShippingCountry = 'United Kingdom', Industry = 'Retail');
Account electrolux = new Account(Name = 'Electrolux Group', Website = 'https://www.electroluxgroup.com', ShippingCountry = 'Sweden', Industry = 'Manufacturing');
Account saintGobain = new Account(Name = 'Saint-Gobain', ShippingCountry = 'France');
insert new List<Account>{ osf, mands, electrolux, saintGobain };

Contact dana = new Contact(AccountId = osf.Id, FirstName = 'Dana', LastName = 'Lee', Title = 'Chief Financial Officer');
Contact sam = new Contact(AccountId = osf.Id, FirstName = 'Sam', LastName = 'Ortiz', Title = 'IT Director');
Contact rita = new Contact(AccountId = osf.Id, FirstName = 'Rita', LastName = 'Gomez', Title = 'VP Sales Operations');
Contact omar = new Contact(AccountId = mands.Id, FirstName = 'Omar', LastName = 'Haddad', Title = 'Head of Customer Service');
Contact lena = new Contact(AccountId = mands.Id, FirstName = 'Lena', LastName = 'Novak', Title = 'Procurement Manager');
Contact erik = new Contact(AccountId = electrolux.Id, FirstName = 'Erik', LastName = 'Lindqvist', Title = 'Director of Service Operations');
insert new List<Contact>{ dana, sam, rita, omar, lena, erik };

Opportunity nwRenewal = new Opportunity(AccountId = osf.Id, Name = 'OSF Digital - Analytics Renewal', StageName = 'Negotiation/Review',
    CloseDate = today.addDays(25), Amount = 96000, NextStep = 'Send multi-year renewal quote',
    Description = 'Renewal of 75 Acme Analytics seats. Dana wants a multi-year discount and a usage review.');
Opportunity nwPipelines = new Opportunity(AccountId = osf.Id, Name = 'OSF Digital - Data Pipelines', StageName = 'Qualification',
    CloseDate = today.addDays(-5), Amount = 40000, NextStep = 'Technical scoping call with Sam',
    Description = 'Sam wants to replace nightly CSV exports from their project delivery system.');
Opportunity nwField = new Opportunity(AccountId = osf.Id, Name = 'OSF Digital - Field Service', StageName = 'Closed Lost',
    CloseDate = today.addMonths(-6), Amount = 30000, Description = 'Lost on price to a niche competitor.');
Opportunity bfService = new Opportunity(AccountId = mands.Id, Name = 'Marks and Spencer - Service Desk Expansion', StageName = 'Proposal/Price Quote',
    CloseDate = today.addDays(40), Amount = 72000, NextStep = 'Present proposal to Omar and procurement',
    Description = 'Add 60 Service Desk agents for the holiday season peak.');
Opportunity bfCrm = new Opportunity(AccountId = mands.Id, Name = 'Marks and Spencer - CRM Cloud', StageName = 'Closed Won',
    CloseDate = today.addMonths(-14), Amount = 120000);
Opportunity elxService = new Opportunity(AccountId = electrolux.Id, Name = 'Electrolux Group - Field Service Pilot', StageName = 'Needs Analysis',
    CloseDate = today.addDays(60), Amount = 55000, NextStep = 'Agree pilot scope with Erik',
    Description = 'Pilot Acme Field Service for appliance repair technicians in two countries.');
insert new List<Opportunity>{ nwRenewal, nwPipelines, nwField, bfService, bfCrm, elxService };

insert new List<OpportunityContactRole>{
    new OpportunityContactRole(OpportunityId = nwRenewal.Id, ContactId = dana.Id, Role = 'Decision Maker', IsPrimary = true),
    new OpportunityContactRole(OpportunityId = nwRenewal.Id, ContactId = rita.Id, Role = 'Influencer'),
    new OpportunityContactRole(OpportunityId = nwPipelines.Id, ContactId = sam.Id, Role = 'Technical Buyer', IsPrimary = true),
    new OpportunityContactRole(OpportunityId = bfService.Id, ContactId = omar.Id, Role = 'Decision Maker', IsPrimary = true),
    new OpportunityContactRole(OpportunityId = bfService.Id, ContactId = lena.Id, Role = 'Economic Buyer'),
    new OpportunityContactRole(OpportunityId = elxService.Id, ContactId = erik.Id, Role = 'Decision Maker', IsPrimary = true)
};

insert new List<Product_Subscription__c>{
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme Analytics', Quantity__c = 50,
        Start_Date__c = today.addYears(-2), End_Date__c = today.addDays(30)),
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme Analytics', Quantity__c = 25,
        Start_Date__c = today.addMonths(-8), End_Date__c = today.addDays(30)),
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme CRM Cloud', Quantity__c = 120,
        Start_Date__c = today.addYears(-3), End_Date__c = today.addMonths(14)),
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme Secure Identity', Quantity__c = 300,
        Start_Date__c = today.addYears(-1)),
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme Legacy Reports', Quantity__c = 10,
        Start_Date__c = today.addYears(-4), End_Date__c = today.addMonths(-11)),
    new Product_Subscription__c(Account__c = osf.Id, Product_Name__c = 'Acme Field Service', Quantity__c = 15,
        Start_Date__c = today.addYears(-3), End_Date__c = today.addMonths(-7)),
    new Product_Subscription__c(Account__c = mands.Id, Product_Name__c = 'Acme CRM Cloud', Quantity__c = 200,
        Start_Date__c = today.addMonths(-14), End_Date__c = today.addMonths(22)),
    new Product_Subscription__c(Account__c = mands.Id, Product_Name__c = 'Acme Service Desk', Quantity__c = 80,
        Start_Date__c = today.addMonths(-14), End_Date__c = today.addDays(150)),
    new Product_Subscription__c(Account__c = electrolux.Id, Product_Name__c = 'Acme Analytics', Quantity__c = 40,
        Start_Date__c = today.addMonths(-10), End_Date__c = today.addMonths(14))
};

Datetime now = Datetime.now();
insert new List<Conversation__c>{
    new Conversation__c(Account__c = osf.Id, Contact__c = dana.Id, Opportunity__c = nwRenewal.Id,
        Start_Time__c = now.addDays(-6), Type__c = 'Video Meeting', Direction__c = 'Outbound', Duration_Minutes__c = 30,
        Subject__c = 'Renewal pricing', Sentiment__c = 'Neutral', Disposition__c = 'Follow-up scheduled',
        Summary__c = 'Dana said budgets are flat next year and asked for a multi-year discount. We promised a usage report showing seat adoption before the renewal meeting.'),
    new Conversation__c(Account__c = osf.Id, Contact__c = sam.Id, Opportunity__c = nwPipelines.Id,
        Start_Time__c = now.addDays(-20), Type__c = 'Call', Direction__c = 'Inbound', Duration_Minutes__c = 18,
        Subject__c = 'Delivery data exports', Sentiment__c = 'Positive', Disposition__c = 'Connected',
        Summary__c = 'Sam described nightly CSV exports from their project delivery system that break weekly. He is interested in Acme Data Pipelines and wants a technical scoping call.'),
    new Conversation__c(Account__c = osf.Id, Contact__c = rita.Id,
        Start_Time__c = now.addDays(-45), Type__c = 'Call', Direction__c = 'Outbound', Duration_Minutes__c = 12,
        Subject__c = 'Forecast dashboards', Sentiment__c = 'Positive', Disposition__c = 'Connected',
        Summary__c = 'Rita said her team relies on the Analytics forecast dashboards every Monday and wants 10 more seats for new regional managers.'),
    new Conversation__c(Account__c = osf.Id, Contact__c = dana.Id, Opportunity__c = nwField.Id,
        Start_Time__c = now.addMonths(-6), Type__c = 'Call', Direction__c = 'Outbound', Duration_Minutes__c = 15,
        Subject__c = 'Field Service decision', Sentiment__c = 'Negative', Disposition__c = 'Connected',
        Summary__c = 'Dana chose a cheaper niche vendor for field service and said our pricing felt rigid.'),
    new Conversation__c(Account__c = mands.Id, Contact__c = omar.Id, Opportunity__c = bfService.Id,
        Start_Time__c = now.addDays(-9), Type__c = 'In Person', Direction__c = 'Outbound', Duration_Minutes__c = 50,
        Subject__c = 'Holiday staffing plan', Sentiment__c = 'Positive', Disposition__c = 'Proposal requested',
        Summary__c = 'Omar needs 60 more Service Desk agents before the holiday peak. Asked for a proposal including self-service portal setup.'),
    new Conversation__c(Account__c = mands.Id, Contact__c = lena.Id, Opportunity__c = bfService.Id,
        Start_Time__c = now.addDays(-3), Type__c = 'Call', Direction__c = 'Inbound', Duration_Minutes__c = 10,
        Subject__c = 'Procurement process', Sentiment__c = 'Neutral', Disposition__c = 'Connected',
        Summary__c = 'Lena said any contract over 50k needs a security review, which takes about three weeks.'),
    new Conversation__c(Account__c = electrolux.Id, Contact__c = erik.Id, Opportunity__c = elxService.Id,
        Start_Time__c = now.addDays(-12), Type__c = 'Video Meeting', Direction__c = 'Outbound', Duration_Minutes__c = 40,
        Subject__c = 'Technician scheduling', Sentiment__c = 'Positive', Disposition__c = 'Follow-up scheduled',
        Summary__c = 'Erik said repair technicians lose an hour a day to manual scheduling. He wants a pilot in two countries and asked how Field Service links to the Analytics dashboards they already use.')
};

insert new List<Event>{
    new Event(WhatId = nwRenewal.Id, WhoId = dana.Id, Subject = 'Analytics renewal review',
        StartDateTime = now.addDays(2), DurationInMinutes = 45, Description = 'Walk through usage and renewal options.'),
    new Event(WhatId = bfService.Id, WhoId = omar.Id, Subject = 'Service Desk expansion proposal',
        StartDateTime = now.addDays(1), DurationInMinutes = 60),
    new Event(WhatId = elxService.Id, WhoId = erik.Id, Subject = 'Field Service pilot scoping',
        StartDateTime = now.addDays(3), DurationInMinutes = 45, Description = 'Agree pilot countries, technician count and success metrics.')
};
insert new Task(WhatId = osf.Id, WhoId = sam.Id, Subject = 'Data Pipelines scoping call',
    ActivityDate = today.addDays(6), Status = 'Not Started', Priority = 'Normal');

// Public executives, so the enrichment API can identify them. No contact details are seeded.
insert new List<Lead>{
    new Lead(FirstName = 'Amir', LastName = 'Halloul', Company = 'OSF Digital', Website = 'https://osf.digital', LeadSource = 'Web'),
    new Lead(FirstName = 'Stuart', LastName = 'Machin', Company = 'Marks and Spencer', Website = 'https://www.marksandspencer.com', LeadSource = 'Web')
};

System.debug('Seeded OSF Digital ' + osf.Id + ', Marks and Spencer ' + mands.Id + ', Electrolux Group ' + electrolux.Id
    + ', Saint-Gobain ' + saintGobain.Id);
